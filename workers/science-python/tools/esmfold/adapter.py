"""ESMFold adapter for ProtClaw.

Wraps ESMFold for structure prediction from amino acid sequences.
Input: FASTA file(s) with sequences.
Output: Predicted PDB structures with pLDDT and pTM confidence scores.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult

logger = logging.getLogger(__name__)


class ESMFoldAdapter(BaseTool):
    """Adapter for ESMFold structure prediction."""

    tool_name = "esmfold"
    tool_version = "1.0.0"

    DEFAULTS: dict[str, Any] = {
        "num_recycles": 4,
        "chunk_size": None,
    }

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate ESMFold input parameters.

        Required:
            fasta_files: list[str] - FASTA filenames in input_dir/files/

        Optional:
            num_recycles: int - Number of recycling iterations (default: 4)
            chunk_size: int | None - Chunk size for large sequences
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required: fasta_files
        fasta_files = validated.get("fasta_files")
        if not fasta_files or not isinstance(fasta_files, list):
            raise ValueError("'fasta_files' is required and must be a non-empty list")

        for f in fasta_files:
            fname = str(f)
            if not (fname.endswith(".fasta") or fname.endswith(".fa")):
                raise ValueError(f"Expected .fasta or .fa file, got: {f}")

        validated["fasta_files"] = [str(f) for f in fasta_files]

        # Validate num_recycles
        num_recycles = int(validated["num_recycles"])
        if num_recycles < 0 or num_recycles > 48:
            raise ValueError(f"num_recycles must be 0-48, got {num_recycles}")
        validated["num_recycles"] = num_recycles

        # Validate chunk_size if provided
        if validated["chunk_size"] is not None:
            chunk_size = int(validated["chunk_size"])
            if chunk_size < 1:
                raise ValueError(f"chunk_size must be positive, got {chunk_size}")
            validated["chunk_size"] = chunk_size

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute ESMFold structure prediction.

        Loads the ESMFold model, folds each sequence from input FASTA files,
        and writes predicted PDB structures with confidence scores.
        """
        fasta_files = params["fasta_files"]
        num_recycles = params["num_recycles"]
        chunk_size = params.get("chunk_size")

        # Import heavy dependencies only at execution time
        try:
            import torch
            import esm
        except ImportError as e:
            return self.build_error_result(
                f"Failed to import ESMFold dependencies: {e}. "
                f"Ensure torch and fair-esm are installed."
            )

        # Check CUDA availability
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cpu":
            logger.warning("CUDA not available, running ESMFold on CPU (will be slow)")

        # Load model
        logger.info("Loading ESMFold model (this may take a minute on first run)...")
        try:
            model = esm.pretrained.esmfold_v1()
            model = model.set_chunk_size(chunk_size) if chunk_size else model
            model = model.eval()
            if device == "cuda":
                model = model.cuda()
        except Exception as e:
            return self.build_error_result(f"Failed to load ESMFold model: {e}")

        output_files = []
        all_plddt_scores: list[float] = []
        all_ptm_scores: list[float] = []

        try:
            for fasta_filename in fasta_files:
                fasta_path = os.path.join(input_dir, fasta_filename)

                if not os.path.isfile(fasta_path):
                    return self.build_error_result(f"FASTA file not found: {fasta_path}")

                # Parse sequences from FASTA
                sequences = _parse_fasta(fasta_path)
                if not sequences:
                    return self.build_error_result(f"No sequences found in {fasta_filename}")

                for seq_name, sequence in sequences:
                    logger.info(
                        "Folding %s (%d residues, %d recycles)",
                        seq_name, len(sequence), num_recycles,
                    )

                    # Run ESMFold inference
                    try:
                        with torch.no_grad():
                            output = model.infer(sequence, num_recycles=num_recycles)

                        # Extract PDB string
                        pdb_str = model.output_to_pdb(output)[0]

                        # Extract confidence scores
                        plddt = output["plddt"].mean().item()
                        ptm = output["ptm"].item()

                    except RuntimeError as e:
                        if "out of memory" in str(e).lower():
                            # Try to recover GPU memory
                            if device == "cuda":
                                torch.cuda.empty_cache()
                            return self.build_error_result(
                                f"GPU out of memory for sequence {seq_name} "
                                f"({len(sequence)} residues). Try setting chunk_size=64."
                            )
                        raise

                    # Write PDB file
                    safe_name = seq_name.replace("/", "_").replace(" ", "_")[:50]
                    pdb_filename = f"{safe_name}_predicted.pdb"
                    pdb_path = os.path.join(output_dir, pdb_filename)

                    with open(pdb_path, "w") as f:
                        f.write(pdb_str)

                    output_files.append(pdb_path)
                    all_plddt_scores.append(plddt)
                    all_ptm_scores.append(ptm)

                    logger.info(
                        "Folded %s: pLDDT=%.1f, pTM=%.4f",
                        seq_name, plddt, ptm,
                    )

        finally:
            # Always free GPU memory
            del model
            if device == "cuda":
                torch.cuda.empty_cache()
            logger.info("ESMFold model unloaded, GPU memory freed")

        if not output_files:
            return self.build_error_result("No structures were predicted")

        avg_plddt = sum(all_plddt_scores) / len(all_plddt_scores)
        avg_ptm = sum(all_ptm_scores) / len(all_ptm_scores)

        return self.build_result(
            status="success",
            output_files=output_files,
            metrics={
                "num_structures_predicted": len(output_files),
                "avg_plddt": round(avg_plddt, 2),
                "avg_ptm": round(avg_ptm, 4),
                "num_recycles": num_recycles,
            },
        )


def _parse_fasta(filepath: str) -> list[tuple[str, str]]:
    """Parse a FASTA file into a list of (name, sequence) tuples."""
    sequences: list[tuple[str, str]] = []
    current_name = ""
    current_seq_parts: list[str] = []

    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if current_name:
                    sequences.append((current_name, "".join(current_seq_parts)))
                current_name = line[1:].split()[0]  # First word after '>'
                current_seq_parts = []
            else:
                current_seq_parts.append(line)

    if current_name:
        sequences.append((current_name, "".join(current_seq_parts)))

    return sequences


def create_adapter() -> ESMFoldAdapter:
    """Factory function to create adapter instance."""
    return ESMFoldAdapter()
