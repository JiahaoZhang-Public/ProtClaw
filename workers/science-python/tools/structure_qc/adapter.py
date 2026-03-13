"""Structure QC adapter for ProtClaw.

Performs quality control checks on protein structures using BioPython.
Computes RMSD between predicted and designed structures, clash scores,
and Ramachandran statistics.
Input: predicted PDB + designed PDB.
Output: QC metrics dict with RMSD, clash score, Ramachandran stats.
"""

from __future__ import annotations

import json
import logging
import math
import os
from typing import Any

from common.adapter_protocol import BaseTool, ToolResult

logger = logging.getLogger(__name__)


class StructureQCAdapter(BaseTool):
    """Adapter for protein structure quality control."""

    tool_name = "structure_qc"
    tool_version = "1.0.0"

    DEFAULTS: dict[str, Any] = {
        "clash_distance_threshold": 2.0,
        "alignment_method": "ca",  # "ca" (C-alpha) or "backbone"
    }

    def validate_input(self, params: dict[str, Any]) -> dict[str, Any]:
        """Validate structure QC input parameters.

        Required:
            predicted_pdb: str - Predicted structure PDB filename
            designed_pdb: str - Designed/reference structure PDB filename

        Optional:
            clash_distance_threshold: float - Threshold for clash detection (default: 2.0 A)
            alignment_method: str - "ca" or "backbone" (default: "ca")
        """
        validated = dict(self.DEFAULTS)
        validated.update(params)

        # Required fields
        if "predicted_pdb" not in validated or not validated["predicted_pdb"]:
            raise ValueError("'predicted_pdb' is required")
        if "designed_pdb" not in validated or not validated["designed_pdb"]:
            raise ValueError("'designed_pdb' is required")

        for key in ("predicted_pdb", "designed_pdb"):
            if not str(validated[key]).endswith(".pdb"):
                raise ValueError(f"'{key}' must be a .pdb file, got: {validated[key]}")
            validated[key] = str(validated[key])

        # Validate clash_distance_threshold
        threshold = float(validated["clash_distance_threshold"])
        if threshold <= 0.0:
            raise ValueError(f"clash_distance_threshold must be positive, got {threshold}")
        validated["clash_distance_threshold"] = threshold

        # Validate alignment_method
        method = str(validated["alignment_method"])
        if method not in ("ca", "backbone"):
            raise ValueError(f"alignment_method must be 'ca' or 'backbone', got '{method}'")
        validated["alignment_method"] = method

        return validated

    def execute(self, params: dict[str, Any], input_dir: str, output_dir: str) -> ToolResult:
        """Execute structure QC analysis.

        Compares predicted and designed structures, computing RMSD,
        clash score, and Ramachandran statistics.
        """
        try:
            from Bio.PDB import PDBParser, Superimposer
        except ImportError as e:
            return self.build_error_result(
                f"BioPython not installed: {e}. Install with: pip install biopython"
            )

        predicted_path = os.path.join(input_dir, params["predicted_pdb"])
        designed_path = os.path.join(input_dir, params["designed_pdb"])

        if not os.path.isfile(predicted_path):
            return self.build_error_result(f"Predicted PDB not found: {predicted_path}")
        if not os.path.isfile(designed_path):
            return self.build_error_result(f"Designed PDB not found: {designed_path}")

        method = params["alignment_method"]
        clash_threshold = params["clash_distance_threshold"]

        parser = PDBParser(QUIET=True)

        try:
            pred_struct = parser.get_structure("pred", predicted_path)
            des_struct = parser.get_structure("des", designed_path)
        except Exception as e:
            return self.build_error_result(f"Failed to parse PDB files: {e}")

        # Extract atoms for alignment
        pred_atoms = _extract_atoms(pred_struct, method)
        des_atoms = _extract_atoms(des_struct, method)

        if len(pred_atoms) < 3 or len(des_atoms) < 3:
            return self.build_error_result(
                f"Too few atoms for alignment: predicted={len(pred_atoms)}, "
                f"designed={len(des_atoms)} (need >= 3)"
            )

        # Align on the shorter chain
        min_len = min(len(pred_atoms), len(des_atoms))
        pred_atoms_aligned = pred_atoms[:min_len]
        des_atoms_aligned = des_atoms[:min_len]

        # Compute RMSD via Superimposer
        sup = Superimposer()
        try:
            sup.set_atoms(des_atoms_aligned, pred_atoms_aligned)
            rmsd = sup.rms
        except Exception as e:
            return self.build_error_result(f"Superimposer failed: {e}")

        # Clash detection on predicted structure
        clash_count, total_pairs = _detect_clashes(pred_struct, clash_threshold)
        clash_score = clash_count / max(total_pairs, 1) if total_pairs > 0 else 0.0

        # Ramachandran analysis on predicted structure
        rama = _compute_ramachandran(pred_struct)

        qc_metrics = {
            "rmsd_angstrom": round(rmsd, 3),
            "clash_score": round(clash_score, 6),
            "clash_count": clash_count,
            "total_atom_pairs_checked": total_pairs,
            "clash_distance_threshold": clash_threshold,
            "alignment_method": method,
            "aligned_residues": min_len,
            "ramachandran": rama,
            "predicted_pdb": params["predicted_pdb"],
            "designed_pdb": params["designed_pdb"],
        }

        # Write QC report
        report_path = os.path.join(output_dir, "qc_report.json")
        with open(report_path, "w") as f:
            json.dump(qc_metrics, f, indent=2)

        logger.info(
            "QC: RMSD=%.3f A, clashes=%d, Rama favored=%.1f%%",
            rmsd, clash_count, rama.get("favored_pct", 0),
        )

        return self.build_result(
            status="success",
            output_files=[report_path],
            metrics=qc_metrics,
        )


def _extract_atoms(structure, method: str) -> list:
    """Extract atoms from structure for alignment.

    Args:
        structure: BioPython Structure object
        method: "ca" for C-alpha only, "backbone" for N, CA, C atoms
    """
    atoms = []
    backbone_names = {"CA"} if method == "ca" else {"N", "CA", "C"}

    for model in structure:
        for chain in model:
            for residue in chain:
                # Skip heteroatoms and water
                if residue.id[0] != " ":
                    continue
                for atom in residue:
                    if atom.get_name() in backbone_names:
                        atoms.append(atom)
        break  # Only first model

    return atoms


def _detect_clashes(structure, threshold: float) -> tuple[int, int]:
    """Detect steric clashes in a structure.

    Returns (clash_count, total_pairs_checked).
    Only checks non-bonded heavy atom pairs (skip i, i+1 residues).
    """
    # Collect all heavy atoms with residue info
    atom_list = []
    for model in structure:
        for chain in model:
            for residue in chain:
                if residue.id[0] != " ":
                    continue
                res_idx = residue.id[1]
                chain_id = chain.id
                for atom in residue:
                    if atom.element == "H":
                        continue
                    atom_list.append((atom, chain_id, res_idx))
        break  # Only first model

    clash_count = 0
    total_pairs = 0
    n = len(atom_list)

    for i in range(n):
        a1, c1, r1 = atom_list[i]
        for j in range(i + 1, n):
            a2, c2, r2 = atom_list[j]
            # Skip bonded neighbors (same chain, adjacent residues)
            if c1 == c2 and abs(r1 - r2) <= 1:
                continue
            total_pairs += 1
            dist = a1 - a2  # BioPython atom distance
            if dist < threshold:
                clash_count += 1

    return clash_count, total_pairs


def _compute_ramachandran(structure) -> dict[str, float]:
    """Compute Ramachandran statistics for a structure.

    Classifies each residue's phi/psi angles into:
    - Favored: core regions
    - Allowed: marginal regions
    - Outlier: disallowed regions
    """
    try:
        from Bio.PDB.Polypeptide import PPBuilder
    except ImportError:
        return {"favored_pct": 0.0, "allowed_pct": 0.0, "outlier_pct": 0.0, "total_residues": 0}

    ppb = PPBuilder()
    phi_psi_list = []

    for model in structure:
        for pp in ppb.build_peptides(model):
            angles = pp.get_phi_psi_list()
            for phi, psi in angles:
                if phi is not None and psi is not None:
                    phi_psi_list.append((math.degrees(phi), math.degrees(psi)))
        break  # Only first model

    if not phi_psi_list:
        return {"favored_pct": 0.0, "allowed_pct": 0.0, "outlier_pct": 0.0, "total_residues": 0}

    favored = 0
    allowed = 0
    outlier = 0

    for phi, psi in phi_psi_list:
        if _is_favored(phi, psi):
            favored += 1
        elif _is_allowed(phi, psi):
            allowed += 1
        else:
            outlier += 1

    total = len(phi_psi_list)
    return {
        "favored_pct": round(100.0 * favored / total, 1),
        "allowed_pct": round(100.0 * allowed / total, 1),
        "outlier_pct": round(100.0 * outlier / total, 1),
        "total_residues": total,
    }


def _is_favored(phi: float, psi: float) -> bool:
    """Check if phi/psi falls in a favored Ramachandran region.

    Simplified regions based on Lovell et al. (2003):
    - Beta sheet: phi in [-180, -50], psi in [50, 180] or [-180, -120]
    - Alpha helix: phi in [-120, -30], psi in [-80, 0]
    - Left-handed helix: phi in [30, 90], psi in [-30, 60]
    """
    # Beta-sheet region (broad)
    if -180 <= phi <= -50 and (50 <= psi <= 180 or -180 <= psi <= -120):
        return True
    # Alpha-helix region
    if -120 <= phi <= -30 and -80 <= psi <= 0:
        return True
    # Left-handed helix (for Gly)
    if 30 <= phi <= 90 and -30 <= psi <= 60:
        return True
    return False


def _is_allowed(phi: float, psi: float) -> bool:
    """Check if phi/psi falls in an allowed Ramachandran region.

    Extended regions around the favored areas.
    """
    # Extended beta
    if -180 <= phi <= -30 and (20 <= psi <= 180 or -180 <= psi <= -90):
        return True
    # Extended alpha
    if -160 <= phi <= -10 and -100 <= psi <= 20:
        return True
    # Extended left-handed
    if 10 <= phi <= 120 and -60 <= psi <= 90:
        return True
    return False


def create_adapter() -> StructureQCAdapter:
    """Factory function to create adapter instance."""
    return StructureQCAdapter()
