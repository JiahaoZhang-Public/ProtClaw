---
name: developability
description: >
  Developability assessment for designed protein sequences. Computes molecular weight,
  isoelectric point (pI), hydrophobicity profile, and aggregation propensity. Use
  after structure QC to evaluate manufacturing feasibility of protein candidates.
compatibility: CPU-only. Requires conda with biopython. See infrastructure.yaml.
metadata:
  version: "1.0.0"
  author: protclaw
  gpu: none
  cost-tier: fast
allowed-tools: Bash(python:*) Read
---

# Developability — Manufacturing Feasibility Assessment

## When to Use

Call this skill when the user wants to:
- Assess whether a designed protein is manufacturable
- Compute biophysical properties (MW, pI, hydrophobicity)
- Evaluate aggregation risk
- Filter candidates by developability criteria

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| fasta_file | file (.fasta) | Yes | — | FASTA file with designed sequences |
| hydrophobicity_window | int | | 7 | Window size for hydrophobicity profile |

## Output

- `developability_report.json` — Per-sequence biophysical property metrics

## Usage Example

```json
{
  "fasta_file": "designed_sequences.fasta",
  "hydrophobicity_window": 7
}
```

## Runtime Requirements

- Environment: `protclaw-cpu` (shared with structure_qc, candidate_ops, experiment_package)
- GPU: none (CPU-only)
- Estimated runtime: < 1 min
