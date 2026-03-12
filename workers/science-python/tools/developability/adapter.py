"""Developability check adapter for ProtClaw.

Computes developability metrics for protein sequences:
molecular weight, isoelectric point, hydrophobicity, aggregation propensity.
Input: FASTA file with sequence(s).
Output: Scores dict with developability metrics.
"""

from __future__ import annotations

import os
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult


# Standard amino acid molecular weights (Da)
_AA_WEIGHTS: dict[str, float] = {
    "A": 89.09, "R": 174.20, "N": 132.12, "D": 133.10, "C": 121.16,
    "E": 147.13, "Q": 146.15, "G": 75.03, "H": 155.16, "I": 131.17,
    "L": 131.17, "K": 146.19, "M": 149.21, "F": 165.19, "P": 115.13,
    "S": 105.09, "T": 119.12, "W": 204.23, "Y": 181.19, "V": 117.15,
}

# Kyte-Doolittle hydrophobicity scale
_KD_HYDROPHOBICITY: dict[str, float] = {
    "A": 1.8, "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5,
    "E": -3.5, "Q": -3.5, "G": -0.4, "H": -3.2, "I": 4.5,
    "L": 3.8, "K": -3.9, "M": 1.9, "F": 2.8, "P": -1.6,
    "S": -0.8, "T": -0.7, "W": -0.9, "Y": -1.3, "V": 4.2,
}

# pK values for isoelectric point calculation
_PK_VALUES: dict[str, float] = {
    "C_term": 3.55, "N_term": 7.59,
    "D": 4.05, "E": 4.45, "C": 9.0, "Y": 10.0,
    "H": 5.98, "K": 10.0, "R": 12.0,
}

# Water molecular weight (subtracted for each peptide bond)
_WATER_MW = 18.015


class DevelopabilityAdapter(BaseTool):
    """Adapter for protein developability assessment."""

    tool_name = "developability_check"
    tool_version = "1.0.0"

    DEFAULTS: dict[str, Any] = {
        "hydrophobicity_window": 7,
    }

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate developability check input parameters.

        Required:
            fasta_file: str - FASTA filename in input_dir/files/

        Optional:
            hydrophobicity_window: int - Window size for hydrophobicity (default: 7)
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required: fasta_file
        fasta_file = validated.get("fasta_file")
        if not fasta_file:
            raise ValueError("'fasta_file' is required")
        fname = str(fasta_file)
        if not (fname.endswith(".fasta") or fname.endswith(".fa")):
            raise ValueError(f"Expected .fasta or .fa file, got: {fasta_file}")
        validated["fasta_file"] = fname

        # Validate window size
        window = int(validated["hydrophobicity_window"])
        if window < 1 or window > 50:
            raise ValueError(f"hydrophobicity_window must be 1-50, got {window}")
        validated["hydrophobicity_window"] = window

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute developability analysis on protein sequences."""
        fasta_path = os.path.join(input_dir, params["fasta_file"])
        window_size = params["hydrophobicity_window"]

        if not os.path.isfile(fasta_path):
            return self.build_error_result(f"FASTA file not found: {fasta_path}")

        sequences = _parse_fasta(fasta_path)
        if not sequences:
            return self.build_error_result(f"No sequences found in {params['fasta_file']}")

        import json

        results: list[dict[str, Any]] = []

        for seq_name, sequence in sequences:
            sequence_upper = sequence.upper()

            # Compute molecular weight
            mw = _compute_molecular_weight(sequence_upper)

            # Compute isoelectric point
            pi = _compute_isoelectric_point(sequence_upper)

            # Compute mean hydrophobicity
            mean_hydro = _compute_mean_hydrophobicity(sequence_upper)

            # Compute max hydrophobicity in sliding window (aggregation proxy)
            max_window_hydro = _compute_max_window_hydrophobicity(sequence_upper, window_size)

            # Simple aggregation propensity score (higher = more aggregation-prone)
            # Based on mean hydrophobicity and length
            agg_score = max(0.0, mean_hydro) * (len(sequence_upper) / 100.0)

            results.append({
                "sequence_name": seq_name,
                "sequence_length": len(sequence_upper),
                "molecular_weight_da": round(mw, 2),
                "isoelectric_point": round(pi, 2),
                "mean_hydrophobicity": round(mean_hydro, 3),
                "max_window_hydrophobicity": round(max_window_hydro, 3),
                "aggregation_propensity": round(agg_score, 3),
            })

        # Write results
        report_path = os.path.join(output_dir, "developability_report.json")
        with open(report_path, "w") as f:
            json.dump({"sequences": results}, f, indent=2)

        return self.build_result(
            status="success",
            output_files=[report_path],
            metrics={
                "num_sequences_analyzed": len(results),
                "sequences": results,
            },
        )


def _compute_molecular_weight(sequence: str) -> float:
    """Compute molecular weight of a protein sequence in Daltons."""
    weight = sum(_AA_WEIGHTS.get(aa, 0.0) for aa in sequence)
    # Subtract water for each peptide bond
    if len(sequence) > 1:
        weight -= _WATER_MW * (len(sequence) - 1)
    return weight


def _compute_isoelectric_point(sequence: str) -> float:
    """Estimate isoelectric point using the bisection method."""
    # Count charged residues
    charge_residues: dict[str, int] = {}
    for aa in sequence:
        if aa in ("D", "E", "C", "Y", "H", "K", "R"):
            charge_residues[aa] = charge_residues.get(aa, 0) + 1

    def _net_charge(ph: float) -> float:
        # N-terminus positive charge
        charge = 1.0 / (1.0 + 10 ** (ph - _PK_VALUES["N_term"]))
        # C-terminus negative charge
        charge -= 1.0 / (1.0 + 10 ** (_PK_VALUES["C_term"] - ph))

        # Positive residues (H, K, R)
        for aa in ("H", "K", "R"):
            n = charge_residues.get(aa, 0)
            if n > 0:
                charge += n / (1.0 + 10 ** (ph - _PK_VALUES[aa]))

        # Negative residues (D, E, C, Y)
        for aa in ("D", "E", "C", "Y"):
            n = charge_residues.get(aa, 0)
            if n > 0:
                charge -= n / (1.0 + 10 ** (_PK_VALUES[aa] - ph))

        return charge

    # Bisection method
    low, high = 0.0, 14.0
    for _ in range(100):
        mid = (low + high) / 2.0
        charge = _net_charge(mid)
        if charge > 0:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def _compute_mean_hydrophobicity(sequence: str) -> float:
    """Compute mean Kyte-Doolittle hydrophobicity."""
    if not sequence:
        return 0.0
    values = [_KD_HYDROPHOBICITY.get(aa, 0.0) for aa in sequence]
    return sum(values) / len(values)


def _compute_max_window_hydrophobicity(sequence: str, window: int) -> float:
    """Compute max average hydrophobicity over a sliding window."""
    if len(sequence) < window:
        return _compute_mean_hydrophobicity(sequence)

    values = [_KD_HYDROPHOBICITY.get(aa, 0.0) for aa in sequence]
    max_avg = -999.0
    for i in range(len(values) - window + 1):
        window_avg = sum(values[i : i + window]) / window
        max_avg = max(max_avg, window_avg)
    return max_avg


def _parse_fasta(filepath: str) -> list[tuple[str, str]]:
    """Parse a FASTA file into (name, sequence) tuples."""
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
                current_name = line[1:].split()[0]
                current_seq_parts = []
            else:
                current_seq_parts.append(line)

    if current_name:
        sequences.append((current_name, "".join(current_seq_parts)))

    return sequences


def create_adapter() -> DevelopabilityAdapter:
    """Factory function to create adapter instance."""
    return DevelopabilityAdapter()
