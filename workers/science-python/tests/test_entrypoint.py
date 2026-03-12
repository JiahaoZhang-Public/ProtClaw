"""Tests for the container entrypoint module."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from common.adapter_protocol import BaseTool, ToolResult


# ---- Mock adapter for testing ----

class MockAdapter(BaseTool):
    """Mock adapter for testing entrypoint."""

    tool_name = "mock_tool"
    tool_version = "0.0.1"

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        if params.get("should_fail_validation"):
            raise ValueError("validation failed on purpose")
        return params

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        if params.get("should_fail_execution"):
            raise RuntimeError("execution failed on purpose")

        output_file = os.path.join(output_dir, "mock_output.txt")
        with open(output_file, "w") as f:
            f.write("mock result data")

        return self.build_result(
            status="success",
            output_files=[output_file],
            metrics={"mock_metric": 42},
        )


def create_adapter():
    return MockAdapter()


class TestEntrypoint:
    """Tests for the entrypoint main() function."""

    def _run_entrypoint(self, params: dict[str, Any] | None = None) -> tuple[int, dict | None]:
        """Helper to run the entrypoint with given params in a temp workspace."""
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir(parents=True)
            (input_dir / "files").mkdir()
            output_dir.mkdir(parents=True)
            (output_dir / "files").mkdir()

            if params is not None:
                (input_dir / "params.json").write_text(json.dumps(params))

            # Patch the INPUT_DIR and OUTPUT_DIR in the entrypoint module
            with patch("common.entrypoint.INPUT_DIR", input_dir), \
                 patch("common.entrypoint.OUTPUT_DIR", output_dir):
                from common.entrypoint import main
                exit_code = main()

            result = None
            result_file = output_dir / "result.json"
            if result_file.exists():
                result = json.loads(result_file.read_text())

            return exit_code, result

    def test_missing_params_file(self):
        """Entrypoint should fail gracefully when params.json is missing."""
        exit_code, result = self._run_entrypoint(params=None)
        assert exit_code == 1
        assert result is not None
        assert result["status"] == "failed"
        assert "params.json" in result["errors"][0]

    def test_missing_adapter_module(self):
        """Entrypoint should fail when _adapter_module is not specified."""
        exit_code, result = self._run_entrypoint(params={"x": 1})
        assert exit_code == 1
        assert result is not None
        assert result["status"] == "failed"
        assert "_adapter_module" in result["errors"][0]

    def test_invalid_adapter_module(self):
        """Entrypoint should fail for non-existent adapter module."""
        exit_code, result = self._run_entrypoint(
            params={"_adapter_module": "nonexistent.module.that.does.not.exist"}
        )
        assert exit_code == 1
        assert result is not None
        assert result["status"] == "failed"
        assert "Failed to import" in result["errors"][0]

    def test_successful_execution(self):
        """Entrypoint should call adapter and write result.json on success."""
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir(parents=True)
            (input_dir / "files").mkdir()
            output_dir.mkdir(parents=True)
            (output_dir / "files").mkdir()

            params = {
                "_adapter_module": "tests.test_entrypoint",
                "some_param": "value",
            }
            (input_dir / "params.json").write_text(json.dumps(params))

            # Add the workers directory to sys.path so imports work
            workers_dir = str(Path(__file__).parent.parent)
            original_path = sys.path.copy()
            if workers_dir not in sys.path:
                sys.path.insert(0, workers_dir)

            try:
                with patch("common.entrypoint.INPUT_DIR", input_dir), \
                     patch("common.entrypoint.OUTPUT_DIR", output_dir):
                    from common.entrypoint import main
                    exit_code = main()
            finally:
                sys.path = original_path

            assert exit_code == 0

            result_file = output_dir / "result.json"
            assert result_file.exists()

            result = json.loads(result_file.read_text())
            assert result["status"] == "success"
            assert result["tool_name"] == "mock_tool"
            assert result["metrics"]["mock_metric"] == 42

    def test_validation_failure(self):
        """Entrypoint should write error result on validation failure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir(parents=True)
            (input_dir / "files").mkdir()
            output_dir.mkdir(parents=True)
            (output_dir / "files").mkdir()

            params = {
                "_adapter_module": "tests.test_entrypoint",
                "should_fail_validation": True,
            }
            (input_dir / "params.json").write_text(json.dumps(params))

            workers_dir = str(Path(__file__).parent.parent)
            original_path = sys.path.copy()
            if workers_dir not in sys.path:
                sys.path.insert(0, workers_dir)

            try:
                with patch("common.entrypoint.INPUT_DIR", input_dir), \
                     patch("common.entrypoint.OUTPUT_DIR", output_dir):
                    from common.entrypoint import main
                    exit_code = main()
            finally:
                sys.path = original_path

            assert exit_code == 1

            result_file = output_dir / "result.json"
            assert result_file.exists()

            result = json.loads(result_file.read_text())
            assert result["status"] == "failed"
            assert "validation failed" in result["errors"][0]

    def test_execution_failure(self):
        """Entrypoint should write error result on execution failure."""
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = Path(tmpdir) / "input"
            output_dir = Path(tmpdir) / "output"
            input_dir.mkdir(parents=True)
            (input_dir / "files").mkdir()
            output_dir.mkdir(parents=True)
            (output_dir / "files").mkdir()

            params = {
                "_adapter_module": "tests.test_entrypoint",
                "should_fail_execution": True,
            }
            (input_dir / "params.json").write_text(json.dumps(params))

            workers_dir = str(Path(__file__).parent.parent)
            original_path = sys.path.copy()
            if workers_dir not in sys.path:
                sys.path.insert(0, workers_dir)

            try:
                with patch("common.entrypoint.INPUT_DIR", input_dir), \
                     patch("common.entrypoint.OUTPUT_DIR", output_dir):
                    from common.entrypoint import main
                    exit_code = main()
            finally:
                sys.path = original_path

            assert exit_code == 1

            result_file = output_dir / "result.json"
            assert result_file.exists()

            result = json.loads(result_file.read_text())
            assert result["status"] == "failed"
            assert "execution failed" in result["errors"][0]
