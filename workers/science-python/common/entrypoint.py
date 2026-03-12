"""
Container entry point for ProtClaw science workers.

Reads params.json from /workspace/input/, imports the appropriate adapter,
executes the tool, and writes result.json to /workspace/output/.

Error handling is comprehensive: any unhandled exception is caught and
written as a failed ToolResult to result.json so the orchestrator always
gets structured output.

All logs go to stdout/stderr for capture by the host container runner.
"""

from __future__ import annotations

import importlib
import json
import logging
import sys
import time
import traceback
from pathlib import Path

from common.adapter_protocol import ToolResult

INPUT_DIR = Path("/workspace/input")
OUTPUT_DIR = Path("/workspace/output")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("protclaw.entrypoint")


def write_error_result(error_message: str, tool_name: str = "unknown") -> None:
    """Write a failed ToolResult to the output directory."""
    result = ToolResult(
        status="failed",
        output_files=[],
        metrics={},
        errors=[error_message],
        tool_name=tool_name,
    )
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    result_file = OUTPUT_DIR / "result.json"
    result_file.write_text(json.dumps(result.to_dict(), indent=2))
    logger.error("Error result written to %s: %s", result_file, error_message)


def main() -> int:
    """Main entry point. Returns 0 on success, 1 on failure."""
    logger.info("ProtClaw science worker starting")

    # 1. Read params.json
    params_file = INPUT_DIR / "params.json"
    if not params_file.exists():
        msg = f"params.json not found at {params_file}"
        logger.error(msg)
        write_error_result(msg)
        return 1

    try:
        params = json.loads(params_file.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        msg = f"Failed to read params.json: {exc}"
        logger.error(msg)
        write_error_result(msg)
        return 1

    logger.info("Loaded params: %s", {k: v for k, v in params.items() if not k.startswith("_")})

    # 2. Import adapter module
    adapter_module = params.get("_adapter_module")
    if not adapter_module:
        msg = "_adapter_module not specified in params"
        logger.error(msg)
        write_error_result(msg)
        return 1

    try:
        mod = importlib.import_module(adapter_module)
    except ImportError as exc:
        msg = f"Failed to import adapter module '{adapter_module}': {exc}"
        logger.error(msg)
        write_error_result(msg)
        return 1

    if not hasattr(mod, "create_adapter"):
        msg = f"Adapter module '{adapter_module}' has no create_adapter() function"
        logger.error(msg)
        write_error_result(msg)
        return 1

    adapter = mod.create_adapter()
    tool_name = getattr(adapter, "tool_name", "unknown")
    logger.info("Adapter loaded: %s v%s", tool_name, getattr(adapter, "tool_version", "?"))

    # 3. Validate inputs
    try:
        validated_params = adapter.validate_input(params)
    except (ValueError, TypeError, KeyError) as exc:
        msg = f"Input validation failed: {exc}"
        logger.error(msg)
        write_error_result(msg, tool_name=tool_name)
        return 1

    logger.info("Input validation passed")

    # 4. Set up workspace directories
    input_files_dir = str(INPUT_DIR / "files")
    output_files_dir = str(OUTPUT_DIR / "files")
    Path(output_files_dir).mkdir(parents=True, exist_ok=True)

    # 5. Execute the tool
    start_time = time.monotonic()
    try:
        result = adapter.execute(validated_params, input_files_dir, output_files_dir)
    except Exception as exc:
        duration = time.monotonic() - start_time
        msg = f"Execution failed after {duration:.1f}s: {exc}\n{traceback.format_exc()}"
        logger.error(msg)
        write_error_result(msg, tool_name=tool_name)
        return 1

    duration = time.monotonic() - start_time
    result.duration_seconds = duration

    # 6. Write result.json
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    result_file = OUTPUT_DIR / "result.json"
    result_file.write_text(json.dumps(result.to_dict(), indent=2))

    logger.info(
        "Execution complete: status=%s, duration=%.1fs, output_files=%d",
        result.status,
        duration,
        len(result.output_files),
    )

    return 0 if result.status == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
