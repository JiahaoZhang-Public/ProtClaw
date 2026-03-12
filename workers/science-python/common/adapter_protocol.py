"""
Standard tool adapter protocol for ProtClaw science workers.

Every science tool adapter must implement the ToolAdapter protocol.
This ensures consistent input validation, cache key computation,
and execution interface across all tools (RFdiffusion, ProteinMPNN, ESMFold, etc.).
"""

from __future__ import annotations

from typing import Any, Protocol


class ToolResult:
    """Standardized result from a tool adapter execution."""

    def __init__(
        self,
        *,
        status: str,
        output_files: list[str],
        metrics: dict[str, Any],
        errors: list[str] | None = None,
    ):
        self.status = status  # "success" | "failed" | "partial"
        self.output_files = output_files
        self.metrics = metrics
        self.errors = errors or []

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "output_files": self.output_files,
            "metrics": self.metrics,
            "errors": self.errors,
        }


class ToolAdapter(Protocol):
    """Protocol that all science tool adapters must implement."""

    tool_name: str
    tool_version: str

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate and normalize input parameters. Raises ValueError on invalid."""
        ...

    def compute_cache_key(self, params: dict[str, Any], input_files: list[str]) -> str:
        """Compute deterministic cache key from normalized inputs."""
        ...

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Run the tool. Read from input_dir, write results to output_dir."""
        ...
