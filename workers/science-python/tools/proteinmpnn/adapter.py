"""ProteinMPNN adapter for ProtClaw.

Wraps ProteinMPNN for inverse folding: given a protein backbone (PDB),
designs amino acid sequences that fold into that structure.
Input: backbone PDB files, number of sequences per structure, sampling temperature.
Output: FASTA files with designed sequences.
"""

from __future__ import annotations

import os
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult


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

        Reads backbone PDB files from input_dir, runs ProteinMPNN, and writes
        designed sequences as FASTA files to output_dir.
        """
        pdb_files = params["pdb_files"]
        num_seqs = params["num_seqs_per_structure"]
        sampling_temp = params["sampling_temp"]

        output_files = []
        total_sequences = 0

        for pdb_filename in pdb_files:
            pdb_path = os.path.join(input_dir, pdb_filename)

            if not os.path.isfile(pdb_path):
                return self.build_error_result(f"PDB file not found: {pdb_path}")

            # TODO: Replace with actual ProteinMPNN model call
            # In production, this would call:
            #   python /opt/proteinmpnn/protein_mpnn_run.py \
            #     --pdb_path {pdb_path} \
            #     --out_folder {output_dir} \
            #     --num_seq_per_target {num_seqs} \
            #     --sampling_temp {sampling_temp}
            #
            # For now, generate stub FASTA output.

            base_name = os.path.splitext(pdb_filename)[0]
            fasta_filename = f"{base_name}_designed.fasta"
            fasta_path = os.path.join(output_dir, fasta_filename)

            with open(fasta_path, "w") as f:
                for seq_idx in range(num_seqs):
                    # Placeholder sequence (poly-alanine)
                    seq_len = 100  # Stub; real implementation reads length from PDB
                    sequence = "A" * seq_len
                    f.write(f">design_{seq_idx:04d}|T={sampling_temp}\n")
                    f.write(f"{sequence}\n")
                    total_sequences += 1

            output_files.append(fasta_path)

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
