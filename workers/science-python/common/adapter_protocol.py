"""
Tool Adapter Protocol for ProtClaw science workers.

Every science tool adapter must implement the ToolAdapter protocol.
This ensures consistent input validation, cache key computation,
and execution interface across all tools (RFdiffusion, ProteinMPNN, ESMFold, etc.).

BaseTool provides default implementations for common operations like
deterministic cache key computation and ToolResult construction.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from abc import ABC, abstractmethod
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


class ToolResult:
    """Standardized result from a tool adapter execution."""

    def __init__(
        self,
        *,
        status: str,
        output_files: list[str],
        metrics: dict[str, Any],
        errors: list[str] | None = None,
        tool_name: str = "",
        tool_version: str = "",
        duration_seconds: float = 0.0,
        cache_key: str = "",
    ):
        self.status = status  # "success" | "failed" | "partial"
        self.output_files = output_files
        self.metrics = metrics
        self.errors = errors or []
        self.tool_name = tool_name
        self.tool_version = tool_version
        self.duration_seconds = duration_seconds
        self.cache_key = cache_key

    def to_dict(self) -> dict[str, Any]:
        """Serialize result to a JSON-compatible dict."""
        return {
            "status": self.status,
            "output_files": self.output_files,
            "metrics": self.metrics,
            "errors": self.errors,
            "tool_name": self.tool_name,
            "tool_version": self.tool_version,
            "duration_seconds": self.duration_seconds,
            "cache_key": self.cache_key,
        }


@runtime_checkable
class ToolAdapter(Protocol):
    """Protocol that all science tool adapters must implement."""

    tool_name: str
    tool_version: str

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate and normalize input parameters. Raise ValueError on invalid input."""
        ...

    def compute_cache_key(self, params: dict[str, Any], input_files: list[str]) -> str:
        """Compute deterministic cache key for this execution."""
        ...

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute the tool. Returns a ToolResult instance."""
        ...


class BaseTool(ABC):
    """Abstract base class providing default implementations for ToolAdapter.

    Subclasses must define tool_name, tool_version, and implement validate_input
    and execute. compute_cache_key has a sensible default based on SHA256.
    """

    tool_name: str
    tool_version: str

    def compute_cache_key(self, params: dict[str, Any], input_files: list[str]) -> str:
        """Compute a deterministic SHA256 cache key from sorted params + file checksums.

        The key is composed of:
        - tool_name and tool_version
        - Sorted JSON serialization of params (excluding internal keys starting with '_')
        - SHA256 checksums of each input file (sorted by filename)
        """
        hasher = hashlib.sha256()

        # Include tool identity
        hasher.update(f"{self.tool_name}:{self.tool_version}".encode())

        # Include sorted params (exclude internal keys starting with '_')
        filtered_params = {k: v for k, v in params.items() if not k.startswith("_")}
        params_json = json.dumps(filtered_params, sort_keys=True, default=str)
        hasher.update(params_json.encode())

        # Include file checksums sorted by filename
        for filepath in sorted(input_files):
            if os.path.isfile(filepath):
                file_hash = hashlib.sha256()
                with open(filepath, "rb") as f:
                    for chunk in iter(lambda: f.read(8192), b""):
                        file_hash.update(chunk)
                hasher.update(f"{os.path.basename(filepath)}:{file_hash.hexdigest()}".encode())

        return hasher.hexdigest()

    @abstractmethod
    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate and normalize input parameters. Raise ValueError on invalid input."""
        ...

    @abstractmethod
    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute the tool. Returns a ToolResult instance."""
        ...

    def build_result(
        self,
        *,
        status: str,
        output_files: list[str] | None = None,
        metrics: dict[str, Any] | None = None,
        errors: list[str] | None = None,
        duration_seconds: float = 0.0,
        cache_key: str = "",
    ) -> ToolResult:
        """Helper to construct a ToolResult with tool identity pre-filled."""
        return ToolResult(
            status=status,
            output_files=output_files or [],
            metrics=metrics or {},
            errors=errors,
            tool_name=self.tool_name,
            tool_version=self.tool_version,
            duration_seconds=duration_seconds,
            cache_key=cache_key,
        )

    def build_error_result(self, error_message: str) -> ToolResult:
        """Helper to construct a failed ToolResult from an error message."""
        return self.build_result(
            status="failed",
            errors=[error_message],
        )

    def timed_execute(
        self, params: dict[str, Any], input_dir: str, output_dir: str
    ) -> ToolResult:
        """Wrapper around execute that records wall-clock duration."""
        start = time.monotonic()
        result = self.execute(params, input_dir, output_dir)
        result.duration_seconds = time.monotonic() - start
        return result


def get_device(prefer_gpu: bool = True) -> str:
    """Detect the best available compute device.

    Returns a PyTorch device string: 'cuda', 'mps', or 'cpu'.

    Priority:
    1. CUDA (if available and prefer_gpu=True)
    2. MPS  (Apple Silicon, if available and prefer_gpu=True)
    3. CPU  (always available)

    Respects CUDA_VISIBLE_DEVICES — if set to empty string or
    no GPUs are visible, falls back to MPS or CPU.

    Usage in adapters:
        from common.adapter_protocol import get_device
        device = get_device()
        model = model.to(device)
    """
    if not prefer_gpu:
        logger.info("Device: cpu (GPU not requested)")
        return "cpu"

    try:
        import torch

        # Check CUDA
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            logger.info("Device: cuda (%s)", gpu_name)
            return "cuda"

        # Check MPS (Apple Silicon)
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            logger.info("Device: mps (Apple Silicon)")
            return "mps"
    except ImportError:
        pass

    logger.info("Device: cpu (no GPU detected)")
    return "cpu"


def get_torch_dtype(device: str) -> Any:
    """Get the appropriate default dtype for a device.

    - CUDA: float16 (fast, well-supported)
    - MPS:  float32 (MPS has limited fp16 support)
    - CPU:  float32

    Usage in adapters:
        device = get_device()
        dtype = get_torch_dtype(device)
        model = model.to(device=device, dtype=dtype)
    """
    try:
        import torch

        if device == "cuda":
            return torch.float16
        return torch.float32
    except ImportError:
        return None
