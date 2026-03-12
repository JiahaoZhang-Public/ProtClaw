"""Tests for each tool adapter's validate_input and output conformance."""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any

import pytest

from common.adapter_protocol import ToolAdapter, ToolResult


# ---- Helper to validate ToolResult conformance ----

def assert_valid_tool_result(result: ToolResult) -> None:
    """Assert that a ToolResult has all required fields with correct types."""
    assert isinstance(result.status, str)
    assert result.status in ("success", "failed", "partial")
    assert isinstance(result.output_files, list)
    assert isinstance(result.metrics, dict)
    assert isinstance(result.errors, list)
    d = result.to_dict()
    assert "status" in d
    assert "output_files" in d
    assert "metrics" in d
    assert "errors" in d


def make_fasta_file(tmpdir: str, name: str, sequences: list[tuple[str, str]]) -> str:
    """Create a FASTA file in tmpdir."""
    path = os.path.join(tmpdir, name)
    with open(path, "w") as f:
        for seq_name, seq in sequences:
            f.write(f">{seq_name}\n{seq}\n")
    return path


def make_pdb_file(tmpdir: str, name: str) -> str:
    """Create a minimal PDB file in tmpdir."""
    path = os.path.join(tmpdir, name)
    with open(path, "w") as f:
        f.write("REMARK   Test PDB\n")
        f.write(
            "ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00"
            "           C\n"
        )
        f.write("END\n")
    return path


# ========================
# RFdiffusion Tests
# ========================

class TestRFdiffusionAdapter:
    def _get_adapter(self):
        from tools.rfdiffusion.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        adapter = self._get_adapter()
        assert isinstance(adapter, ToolAdapter)

    def test_tool_identity(self):
        adapter = self._get_adapter()
        assert adapter.tool_name == "rfdiffusion"
        assert adapter.tool_version == "1.1.0"

    def test_validate_missing_contigs(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="contigs"):
            adapter.validate_input({})

    def test_validate_valid_params(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({"contigs": "100-100", "num_designs": 3})
        assert result["contigs"] == "100-100"
        assert result["num_designs"] == 3

    def test_validate_invalid_num_designs(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="num_designs"):
            adapter.validate_input({"contigs": "100-100", "num_designs": -1})

    def test_execute_produces_output(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            params = adapter.validate_input({"contigs": "50-50", "num_designs": 2})
            result = adapter.execute(params, input_dir, output_dir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert len(result.output_files) == 2
            for f in result.output_files:
                assert os.path.isfile(f)


# ========================
# ProteinMPNN Tests
# ========================

class TestProteinMPNNAdapter:
    def _get_adapter(self):
        from tools.proteinmpnn.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        assert isinstance(self._get_adapter(), ToolAdapter)

    def test_validate_missing_pdb_files(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="pdb_files"):
            adapter.validate_input({})

    def test_validate_invalid_file_extension(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match=".pdb"):
            adapter.validate_input({"pdb_files": ["file.txt"]})

    def test_validate_valid_params(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({
            "pdb_files": ["test.pdb"],
            "num_seqs_per_structure": 4,
        })
        assert result["pdb_files"] == ["test.pdb"]
        assert result["num_seqs_per_structure"] == 4

    def test_execute_produces_fasta(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            make_pdb_file(input_dir, "backbone.pdb")
            params = adapter.validate_input({
                "pdb_files": ["backbone.pdb"],
                "num_seqs_per_structure": 3,
            })
            result = adapter.execute(params, input_dir, output_dir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert len(result.output_files) == 1


# ========================
# ESMFold Tests
# ========================

class TestESMFoldAdapter:
    def _get_adapter(self):
        from tools.esmfold.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        assert isinstance(self._get_adapter(), ToolAdapter)

    def test_validate_missing_fasta(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="fasta_files"):
            adapter.validate_input({})

    def test_validate_valid_params(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({
            "fasta_files": ["seqs.fasta"],
            "num_recycles": 2,
        })
        assert result["fasta_files"] == ["seqs.fasta"]
        assert result["num_recycles"] == 2

    def test_execute_produces_pdb(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            make_fasta_file(input_dir, "seqs.fasta", [
                ("seq1", "ACDEFGHIKLMNPQRSTVWY"),
                ("seq2", "AAAAAAGGGGGG"),
            ])
            params = adapter.validate_input({"fasta_files": ["seqs.fasta"]})
            result = adapter.execute(params, input_dir, output_dir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert len(result.output_files) == 2
            assert result.metrics["avg_plddt"] > 0


# ========================
# Structure QC Tests
# ========================

class TestStructureQCAdapter:
    def _get_adapter(self):
        from tools.structure_qc.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        assert isinstance(self._get_adapter(), ToolAdapter)

    def test_validate_missing_pdbs(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="predicted_pdb"):
            adapter.validate_input({})

    def test_validate_valid_params(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({
            "predicted_pdb": "pred.pdb",
            "designed_pdb": "design.pdb",
        })
        assert result["predicted_pdb"] == "pred.pdb"
        assert result["designed_pdb"] == "design.pdb"

    def test_execute_produces_report(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            make_pdb_file(input_dir, "pred.pdb")
            make_pdb_file(input_dir, "design.pdb")

            params = adapter.validate_input({
                "predicted_pdb": "pred.pdb",
                "designed_pdb": "design.pdb",
            })
            result = adapter.execute(params, input_dir, output_dir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert "rmsd_angstrom" in result.metrics


# ========================
# Developability Tests
# ========================

class TestDevelopabilityAdapter:
    def _get_adapter(self):
        from tools.developability.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        assert isinstance(self._get_adapter(), ToolAdapter)

    def test_validate_missing_fasta(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="fasta_file"):
            adapter.validate_input({})

    def test_validate_valid_params(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({"fasta_file": "seqs.fasta"})
        assert result["fasta_file"] == "seqs.fasta"

    def test_execute_computes_metrics(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            make_fasta_file(input_dir, "seqs.fasta", [
                ("test_protein", "ACDEFGHIKLMNPQRSTVWY"),
            ])
            params = adapter.validate_input({"fasta_file": "seqs.fasta"})
            result = adapter.execute(params, input_dir, output_dir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert result.metrics["num_sequences_analyzed"] == 1

            # Verify the output file contains valid JSON
            report = json.loads(open(result.output_files[0]).read())
            assert len(report["sequences"]) == 1
            seq_data = report["sequences"][0]
            assert "molecular_weight_da" in seq_data
            assert "isoelectric_point" in seq_data
            assert "mean_hydrophobicity" in seq_data


# ========================
# Candidate Ops Tests
# ========================

class TestCandidateOpsAdapter:
    def _get_adapter(self):
        from tools.candidate_ops.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        assert isinstance(self._get_adapter(), ToolAdapter)

    def test_validate_missing_mode(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="mode"):
            adapter.validate_input({"candidates": [{"x": 1}]})

    def test_validate_cluster_mode(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({
            "mode": "cluster",
            "candidates": [{"score": 1.0}, {"score": 2.0}],
            "feature_keys": ["score"],
            "n_clusters": 2,
        })
        assert result["mode"] == "cluster"
        assert result["n_clusters"] == 2

    def test_validate_rank_mode(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({
            "mode": "rank",
            "candidates": [{"rmsd": 1.0, "plddt": 80.0}],
            "rank_objectives": ["rmsd", "plddt"],
            "rank_directions": ["minimize", "maximize"],
        })
        assert result["mode"] == "rank"

    def test_execute_cluster(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            params = adapter.validate_input({
                "mode": "cluster",
                "candidates": [
                    {"name": "c1", "score": 1.0},
                    {"name": "c2", "score": 2.0},
                    {"name": "c3", "score": 3.0},
                ],
                "feature_keys": ["score"],
                "n_clusters": 2,
            })
            result = adapter.execute(params, tmpdir, tmpdir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert result.metrics["mode"] == "cluster"

    def test_execute_rank(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            params = adapter.validate_input({
                "mode": "rank",
                "candidates": [
                    {"name": "c1", "rmsd": 2.0, "plddt": 85.0},
                    {"name": "c2", "rmsd": 1.0, "plddt": 90.0},
                    {"name": "c3", "rmsd": 3.0, "plddt": 70.0},
                ],
                "rank_objectives": ["rmsd", "plddt"],
                "rank_directions": ["minimize", "maximize"],
            })
            result = adapter.execute(params, tmpdir, tmpdir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            assert result.metrics["mode"] == "rank"
            assert result.metrics["num_pareto_fronts"] >= 1


# ========================
# Experiment Package Tests
# ========================

class TestExperimentPackageAdapter:
    def _get_adapter(self):
        from tools.experiment_package.adapter import create_adapter
        return create_adapter()

    def test_is_tool_adapter(self):
        assert isinstance(self._get_adapter(), ToolAdapter)

    def test_validate_missing_candidates(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="candidates"):
            adapter.validate_input({})

    def test_validate_missing_sequence(self):
        adapter = self._get_adapter()
        with pytest.raises(ValueError, match="sequence"):
            adapter.validate_input({"candidates": [{"name": "c1"}]})

    def test_validate_valid_params(self):
        adapter = self._get_adapter()
        result = adapter.validate_input({
            "candidates": [{"sequence": "ACDEF", "name": "c1"}],
            "project_name": "Test Project",
        })
        assert result["project_name"] == "Test Project"

    def test_execute_generates_files(self):
        adapter = self._get_adapter()
        with tempfile.TemporaryDirectory() as tmpdir:
            input_dir = os.path.join(tmpdir, "input")
            output_dir = os.path.join(tmpdir, "output")
            os.makedirs(input_dir)
            os.makedirs(output_dir)

            params = adapter.validate_input({
                "candidates": [
                    {"sequence": "ACDEFGHIKLMNPQRSTVWY", "name": "design_1"},
                    {"sequence": "GGGGGGGGGG", "name": "design_2"},
                ],
                "project_name": "Test",
                "scientist_name": "Dr. Test",
                "top_n": 2,
            })
            result = adapter.execute(params, input_dir, output_dir)
            assert_valid_tool_result(result)
            assert result.status == "success"
            # Should have at least the xlsx file
            assert len(result.output_files) >= 1
