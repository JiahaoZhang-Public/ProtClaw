#!/usr/bin/env python3
"""
generate-py.py

Reads JSON Schema files from schemas/ and generates Pydantic v2 models
in python/protclaw_contracts/generated/.

Usage:
    python scripts/generate-py.py          # Generate files
    python scripts/generate-py.py --check  # Check if generated files are up-to-date
"""

import re
import subprocess
import sys
from pathlib import Path

SCHEMAS_DIR = Path(__file__).parent.parent / "schemas"
GENERATED_DIR = Path(__file__).parent.parent / "python" / "protclaw_contracts" / "generated"
CHECK_MODE = "--check" in sys.argv


def kebab_to_snake(s: str) -> str:
    return s.replace("-", "_")


def generate_model(schema_file: Path, output_file: Path) -> str:
    """Generate a Pydantic model from a JSON Schema file using datamodel-code-generator."""
    result = subprocess.run(
        [
            "datamodel-codegen",
            "--input", str(schema_file),
            "--input-file-type", "jsonschema",
            "--output-model-type", "pydantic_v2.BaseModel",
            "--target-python-version", "3.10",
            "--use-standard-collections",
            "--use-union-operator",
            "--field-constraints",
            "--use-default",
            "--collapse-root-models",
            "--enum-field-as-literal", "all",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"ERROR generating {schema_file.name}: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    # Strip timestamp line to make output deterministic for --check mode
    output = re.sub(r"#   timestamp:.*\n", "", result.stdout)

    # Add header comment
    header = (
        "# Auto-generated from JSON Schema. Do not edit manually.\n"
        f"# Source: schemas/{schema_file.name}\n"
        "# Run `pnpm codegen` from packages/contracts to regenerate.\n\n"
    )

    return header + output


def main() -> None:
    schema_files = sorted(SCHEMAS_DIR.glob("*.schema.json"))

    if not schema_files:
        print(f"No schema files found in {SCHEMAS_DIR}", file=sys.stderr)
        sys.exit(1)

    GENERATED_DIR.mkdir(parents=True, exist_ok=True)

    generated: dict[str, str] = {}
    module_names: list[str] = []

    for schema_file in schema_files:
        name = schema_file.name.replace(".schema.json", "")
        snake_name = kebab_to_snake(name)
        module_names.append(snake_name)

        output_file = GENERATED_DIR / f"{snake_name}.py"
        content = generate_model(schema_file, output_file)
        generated[f"{snake_name}.py"] = content

    # Generate __init__.py
    init_lines = [
        "# Auto-generated barrel export. Do not edit manually.",
        "# Run `pnpm codegen` from packages/contracts to regenerate.",
        "",
    ]
    for module_name in module_names:
        init_lines.append(f"from .{module_name} import *  # noqa: F401, F403")
    init_lines.append("")
    generated["__init__.py"] = "\n".join(init_lines)

    if CHECK_MODE:
        up_to_date = True
        for filename, content in generated.items():
            filepath = GENERATED_DIR / filename
            if not filepath.exists():
                print(f"Missing: {filename}", file=sys.stderr)
                up_to_date = False
                continue
            existing = filepath.read_text()
            if existing != content:
                print(f"Stale: {filename}", file=sys.stderr)
                up_to_date = False

        if not up_to_date:
            print(
                "\nGenerated files are out of date. Run `pnpm codegen` to regenerate.",
                file=sys.stderr,
            )
            sys.exit(1)
        print("All generated Python files are up to date.")
        return

    # Write files
    for filename, content in generated.items():
        filepath = GENERATED_DIR / filename
        filepath.write_text(content)
        print(f"  Generated: python/protclaw_contracts/generated/{filename}")

    print(f"\n{len(generated)} files generated.")


if __name__ == "__main__":
    main()
