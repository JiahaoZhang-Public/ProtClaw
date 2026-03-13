---
name: structure-qc
description: >
  Structural quality control for predicted protein structures. Computes RMSD between
  predicted and designed backbones, detects steric clashes, and analyzes Ramachandran
  phi/psi angles. Use after structure prediction (ESMFold) to validate design quality.
compatibility: CPU-only. Requires conda with biopython. See infrastructure.yaml.
metadata:
  version: "1.0.0"
  author: protclaw
  gpu: none
  cost-tier: fast
allowed-tools: Bash(python:*) Read
---

# Structure QC — Quality Control

## When to Use

Call this skill when the user wants to:
- Validate predicted structures against designed backbones
- Compute RMSD (C-alpha or backbone) between two PDB structures
- Detect steric clashes in predicted structures
- Analyze Ramachandran statistics (favored/allowed/outlier percentages)

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| predicted_pdb | file (.pdb) | Yes | — | Predicted structure PDB filename |
| designed_pdb | file (.pdb) | Yes | — | Original designed backbone PDB filename |
| clash_distance_threshold | float | | 2.0 | Distance threshold for clash detection (Angstroms) |
| alignment_method | string | | "ca" | `ca` for C-alpha only, `backbone` for N/CA/C/O |

## Output

- `qc_report.json` — Metrics: rmsd_angstrom, clash_score, clash_count, ramachandran stats

## Usage Example

```json
{
  "predicted_pdb": "predicted_0000.pdb",
  "designed_pdb": "design_0000.pdb",
  "alignment_method": "ca"
}
```

## Interpreting Results

- **RMSD < 2.0 A**: Excellent — sequence folds very close to designed backbone
- **RMSD 2.0-4.0 A**: Acceptable — moderate structural deviation
- **RMSD > 4.0 A**: Poor — sequence does not fold as designed
- **Clash score**: Lower is better (0.0 = no clashes)
- **Ramachandran favored > 90%**: Good stereochemistry

## Runtime Requirements

- Environment: `protclaw-cpu` (conda, Python 3.11)
- GPU: none (CPU-only)
- Estimated runtime: < 1 min
