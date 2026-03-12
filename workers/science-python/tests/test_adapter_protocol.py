"""Tests for the tool adapter protocol and BaseTool base class."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from typing import Any
from unittest.mock import patch

import pytest

from common.adapter_protocol import BaseTool, ToolAdapter, ToolResult


# ---- Concrete test adapter ----

class DummyTool(BaseTool):
    """Minimal concrete adapter for testing BaseTool defaults."""

    tool_name = "dummy_tool"
    tool_version = "0.1.0"

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        if "required_field" not in params:
            raise ValueError("missing required_field")
        return {"required_field": params["required_field"]}

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        output_file = os.path.join(output_dir, "output.txt")
        with open(output_file, "w") as f:
            f.write("hello")
        return self.build_result(
            status="success",
            output_files=[output_file],
            metrics={"items_processed": 1},
        )


class TestToolResult:
    """Tests for the ToolResult class."""

    def test_to_dict_basic(self):
        result = ToolResult(
            status="success",
            output_files=["a.pdb", "b.pdb"],
            metrics={"rmsd": 1.5},
        )
        d = result.to_dict()
        assert d["status"] == "success"
        assert d["output_files"] == ["a.pdb", "b.pdb"]
        assert d["metrics"]["rmsd"] == 1.5
        assert d["errors"] == []

    def test_to_dict_with_errors(self):
        result = ToolResult(
            status="failed",
            output_files=[],
            metrics={},
            errors=["something went wrong"],
        )
        d = result.to_dict()
        assert d["status"] == "failed"
        assert d["errors"] == ["something went wrong"]

    def test_to_dict_with_metadata(self):
        result = ToolResult(
            status="success",
            output_files=[],
            metrics={},
            tool_name="test_tool",
            tool_version="1.0.0",
            duration_seconds=3.5,
            cache_key="abc123",
        )
        d = result.to_dict()
        assert d["tool_name"] == "test_tool"
        assert d["tool_version"] == "1.0.0"
        assert d["duration_seconds"] == 3.5
        assert d["cache_key"] == "abc123"


class TestToolAdapterProtocol:
    """Tests that ToolAdapter protocol is a runtime-checkable protocol."""

    def test_dummy_tool_is_adapter(self):
        tool = DummyTool()
        assert isinstance(tool, ToolAdapter)

    def test_protocol_has_required_attributes(self):
        tool = DummyTool()
        assert hasattr(tool, "tool_name")
        assert hasattr(tool, "tool_version")
        assert hasattr(tool, "validate_input")
        assert hasattr(tool, "compute_cache_key")
        assert hasattr(tool, "execute")


class TestBaseTool:
    """Tests for BaseTool default implementations."""

    def test_validate_input_raises_on_invalid(self):
        tool = DummyTool()
        with pytest.raises(ValueError, match="missing required_field"):
            tool.validate_input({})

    def test_validate_input_passes_valid(self):
        tool = DummyTool()
        result = tool.validate_input({"required_field": "value"})
        assert result == {"required_field": "value"}

    def test_build_result_fills_tool_identity(self):
        tool = DummyTool()
        result = tool.build_result(status="success")
        assert result.tool_name == "dummy_tool"
        assert result.tool_version == "0.1.0"
        assert result.status == "success"
        assert result.output_files == []
        assert result.metrics == {}
        assert result.errors == []

    def test_build_error_result(self):
        tool = DummyTool()
        result = tool.build_error_result("kaboom")
        assert result.status == "failed"
        assert result.errors == ["kaboom"]
        assert result.tool_name == "dummy_tool"

    def test_execute_writes_output(self):
        tool = DummyTool()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            result = tool.execute(
                {"required_field": "v"},
                input_dir,
                output_dir,
            )
            assert result.status == "success"
            assert len(result.output_files) == 1
            assert os.path.isfile(result.output_files[0])

    def test_timed_execute_records_duration(self):
        tool = DummyTool()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            result = tool.timed_execute(
                {"required_field": "v"},
                input_dir,
                output_dir,
            )
            assert result.duration_seconds >= 0.0
            assert result.status == "success"


class TestCacheKey:
    """Tests for the deterministic cache key computation."""

    def test_cache_key_is_deterministic(self):
        tool = DummyTool()
        params = {"alpha": 1, "beta": "two"}

        key1 = tool.compute_cache_key(params, [])
        key2 = tool.compute_cache_key(params, [])
        assert key1 == key2

    def test_cache_key_changes_with_params(self):
        tool = DummyTool()

        key1 = tool.compute_cache_key({"x": 1}, [])
        key2 = tool.compute_cache_key({"x": 2}, [])
        assert key1 != key2

    def test_cache_key_ignores_internal_keys(self):
        tool = DummyTool()

        key1 = tool.compute_cache_key({"x": 1}, [])
        key2 = tool.compute_cache_key({"x": 1, "_adapter_module": "foo"}, [])
        assert key1 == key2

    def test_cache_key_order_independent(self):
        tool = DummyTool()

        key1 = tool.compute_cache_key({"a": 1, "b": 2}, [])
        key2 = tool.compute_cache_key({"b": 2, "a": 1}, [])
        assert key1 == key2

    def test_cache_key_includes_file_checksums(self):
        tool = DummyTool()
        params = {"x": 1}

        with tempfile.TemporaryDirectory() as tmpdir:
            f1 = os.path.join(tmpdir, "file1.pdb")
            f2 = os.path.join(tmpdir, "file2.pdb")
            with open(f1, "w") as f:
                f.write("content1")
            with open(f2, "w") as f:
                f.write("content2")

            key_no_files = tool.compute_cache_key(params, [])
            key_with_files = tool.compute_cache_key(params, [f1, f2])
            assert key_no_files != key_with_files

    def test_cache_key_file_order_independent(self):
        tool = DummyTool()
        params = {"x": 1}

        with tempfile.TemporaryDirectory() as tmpdir:
            f1 = os.path.join(tmpdir, "aaa.pdb")
            f2 = os.path.join(tmpdir, "bbb.pdb")
            with open(f1, "w") as f:
                f.write("content1")
            with open(f2, "w") as f:
                f.write("content2")

            key1 = tool.compute_cache_key(params, [f1, f2])
            key2 = tool.compute_cache_key(params, [f2, f1])
            assert key1 == key2

    def test_cache_key_is_hex_string(self):
        tool = DummyTool()
        key = tool.compute_cache_key({"x": 1}, [])
        assert len(key) == 64  # SHA256 hex digest
        assert all(c in "0123456789abcdef" for c in key)

    def test_cache_key_skips_nonexistent_files(self):
        tool = DummyTool()
        params = {"x": 1}

        key_no_files = tool.compute_cache_key(params, [])
        key_bad_file = tool.compute_cache_key(params, ["/nonexistent/file.pdb"])
        assert key_no_files == key_bad_file
