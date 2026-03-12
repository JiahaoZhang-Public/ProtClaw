"""ProteinMPNN adapter for ProtClaw.

Wraps ProteinMPNN for inverse folding: given a protein backbone (PDB),
designs amino acid sequences that fold into that structure.
Input: backbone PDB files, number of sequences per structure, sampling temperature.
Output: FASTA files with designed sequences.
"""

from __future__ import annotations

import glob
import logging
import os
import shutil
import subprocess
import sys
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult

logger = logging.getLogger(__name__)


class ProteinMPNNAdapter(BaseTool):
    """Adapter for ProteinMPNN sequence design."""

    tool_name = "proteinmpnn"
    tool_version = "1.0.0"

    DEFAULTS: dict[str, Any] = {
        "num_seqs_per_structure": 8,
        "sampling_temp": 0.1,
        "backbone_noise": 0.0,
        "model_name": "v_48_020",
    }

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate ProteinMPNN input parameters.

        Required:
            pdb_files: list[str] - Backbone PDB filenames (in input_dir/files/)

        Optional:
            num_seqs_per_structure: int - Sequences per structure (default: 8)
            sampling_temp: float - Sampling temperature (default: 0.1)
            backbone_noise: float - Backbone noise augmentation (default: 0.0)
            model_name: str - Model checkpoint name (default: "v_48_020")
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required: pdb_files
        pdb_files = validated.get("pdb_files")
        if not pdb_files or not isinstance(pdb_files, list):
            raise ValueError("'pdb_files' is required and must be a non-empty list of PDB filenames")

        for pdb in pdb_files:
            if not str(pdb).endswith(".pdb"):
                raise ValueError(f"Expected .pdb file, got: {pdb}")

        validated["pdb_files"] = [str(p) for p in pdb_files]

        # Validate num_seqs_per_structure
        num_seqs = int(validated["num_seqs_per_structure"])
        if num_seqs < 1 or num_seqs > 10000:
            raise ValueError(f"num_seqs_per_structure must be 1-10000, got {num_seqs}")
        validated["num_seqs_per_structure"] = num_seqs

        # Validate sampling_temp
        temp = float(validated["sampling_temp"])
        if temp <= 0.0 or temp > 10.0:
            raise ValueError(f"sampling_temp must be in (0.0, 10.0], got {temp}")
        validated["sampling_temp"] = temp

        # Validate backbone_noise
        noise = float(validated["backbone_noise"])
        if noise < 0.0:
            raise ValueError(f"backbone_noise must be non-negative, got {noise}")
        validated["backbone_noise"] = noise

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute ProteinMPNN sequence design.

        For each PDB backbone:
        1. Parse chains using ProteinMPNN helper script
        2. Run protein_mpnn_run.py to design sequences
        3. Collect output FASTA files
        """
        pdb_files = params["pdb_files"]
        num_seqs = params["num_seqs_per_structure"]
        sampling_temp = params["sampling_temp"]
        backbone_noise = params["backbone_noise"]
        model_name = params["model_name"]

        mpnn_dir = os.environ.get("PROTEINMPNN_DIR", "/root/repos/ProteinMPNN")
        weights_dir = os.environ.get("PROTEINMPNN_WEIGHTS", "/root/autodl-tmp/models/proteinmpnn")

        mpnn_script = os.path.join(mpnn_dir, "protein_mpnn_run.py")
        if not os.path.isfile(mpnn_script):
            return self.build_error_result(
                f"ProteinMPNN script not found: {mpnn_script}. "
                f"Is PROTEINMPNN_DIR set correctly?"
            )

        output_files = []
        total_sequences = 0

        for pdb_filename in pdb_files:
            pdb_path = os.path.join(input_dir, pdb_filename)

            if not os.path.isfile(pdb_path):
                return self.build_error_result(f"PDB file not found: {pdb_path}")

            base_name = os.path.splitext(pdb_filename)[0]

            # Step 1: Create a temp directory with just this PDB for parsing
            pdb_input_dir = os.path.join(output_dir, f"{base_name}_input")
            os.makedirs(pdb_input_dir, exist_ok=True)
            shutil.copy2(pdb_path, os.path.join(pdb_input_dir, pdb_filename))

            # Step 2: Parse PDB chains using helper script
            parsed_dir = os.path.join(output_dir, f"{base_name}_parsed")
            os.makedirs(parsed_dir, exist_ok=True)
            parsed_jsonl = os.path.join(parsed_dir, "parsed.jsonl")

            parse_script = os.path.join(mpnn_dir, "helper_scripts", "parse_multiple_chains.py")
            if os.path.isfile(parse_script):
                try:
                    parse_result = subprocess.run(
                        [
                            sys.executable,
                            parse_script,
                            f"--input_path={pdb_input_dir}",
                            f"--output_path={parsed_jsonl}",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=120,
                        cwd=mpnn_dir,
                    )
                    if parse_result.returncode != 0:
                        return self.build_error_result(
                            f"Chain parsing failed for {pdb_filename}: {parse_result.stderr[-500:]}"
                        )
                except subprocess.TimeoutExpired:
                    return self.build_error_result(f"Chain parsing timed out for {pdb_filename}")
            else:
                return self.build_error_result(f"Parse script not found: {parse_script}")

            # Step 3: Run ProteinMPNN
            mpnn_out = os.path.join(output_dir, f"{base_name}_mpnn")
            os.makedirs(mpnn_out, exist_ok=True)

            cmd = [
                sys.executable,
                mpnn_script,
                "--jsonl_path", parsed_jsonl,
                "--out_folder", mpnn_out,
                "--num_seq_per_target", str(num_seqs),
                "--sampling_temp", str(sampling_temp),
                "--backbone_noise", str(backbone_noise),
                "--model_name", model_name,
            ]

            # Add weights path if it exists
            if os.path.isdir(weights_dir):
                cmd.extend(["--path_to_model_weights", weights_dir])

            logger.info("Running ProteinMPNN for %s: %s", pdb_filename, " ".join(cmd))

            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=1800,
                    cwd=mpnn_dir,
                )
            except subprocess.TimeoutExpired:
                return self.build_error_result(
                    f"ProteinMPNN timed out for {pdb_filename}"
                )

            if result.returncode != 0:
                error_tail = result.stderr[-1000:] if result.stderr else "No stderr"
                return self.build_error_result(
                    f"ProteinMPNN failed for {pdb_filename} (exit {result.returncode}):\n{error_tail}"
                )

            # Step 4: Collect output FASTA files
            fasta_glob = os.path.join(mpnn_out, "seqs", "*.fa")
            fasta_files_found = sorted(glob.glob(fasta_glob))

            if not fasta_files_found:
                # Try alternative output locations
                fasta_files_found = sorted(
                    glob.glob(os.path.join(mpnn_out, "**", "*.fa"), recursive=True)
                )

            for fa in fasta_files_found:
                dest = os.path.join(output_dir, f"{base_name}_designed.fasta")
                if os.path.exists(dest):
                    # Append if multiple outputs
                    with open(fa) as src_f, open(dest, "a") as dst_f:
                        dst_f.write(src_f.read())
                else:
                    shutil.copy2(fa, dest)

                # Count sequences
                with open(fa) as fh:
                    total_sequences += sum(1 for line in fh if line.startswith(">"))

                if dest not in output_files:
                    output_files.append(dest)

        if not output_files:
            return self.build_error_result("ProteinMPNN completed but no FASTA files produced")

        logger.info("ProteinMPNN designed %d total sequences", total_sequences)

        return self.build_result(
            status="success",
            output_files=output_files,
            metrics={
                "num_structures_processed": len(pdb_files),
                "total_sequences_designed": total_sequences,
                "sampling_temp": sampling_temp,
            },
        )


def create_adapter() -> ProteinMPNNAdapter:
    """Factory function to create adapter instance."""
    return ProteinMPNNAdapter()
