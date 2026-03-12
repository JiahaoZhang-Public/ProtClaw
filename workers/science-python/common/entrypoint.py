"""
Container entry point for ProtClaw science workers.

Reads params.json from /workspace/input/, imports the appropriate adapter,
executes the tool, and writes result.json to /workspace/output/.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

INPUT_DIR = Path("/workspace/input")
OUTPUT_DIR = Path("/workspace/output")


def main() -> None:
    params_file = INPUT_DIR / "params.json"
    if not params_file.exists():
        print(f"ERROR: {params_file} not found", file=sys.stderr)
        sys.exit(1)

    params = json.loads(params_file.read_text())

    adapter_module = params.get("_adapter_module")
    if not adapter_module:
        print("ERROR: _adapter_module not specified in params", file=sys.stderr)
        sys.exit(1)

    # Import the adapter module and create the adapter instance
    mod = importlib.import_module(adapter_module)
    adapter = mod.create_adapter()

    # Validate inputs
    validated_params = adapter.validate_input(params)

    # Execute
    input_files_dir = str(INPUT_DIR / "files")
    output_files_dir = str(OUTPUT_DIR / "files")
    Path(output_files_dir).mkdir(parents=True, exist_ok=True)

    result = adapter.execute(validated_params, input_files_dir, output_files_dir)

    # Write result
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    result_file = OUTPUT_DIR / "result.json"
    result_file.write_text(json.dumps(result.to_dict(), indent=2))

    print(f"Result written to {result_file}")
    sys.exit(0 if result.status == "success" else 1)


if __name__ == "__main__":
    main()
