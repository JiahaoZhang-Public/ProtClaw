---
name: proteinmpnn
description: >
  Inverse folding — design amino acid sequences for given protein backbones using
  ProteinMPNN. Use after backbone generation (RFdiffusion) to find sequences that
  fold into the designed structure. Supports multi-chain, temperature sampling,
  and backbone noise augmentation.
compatibility: Requires conda, GPU recommended (CUDA/MPS/CPU). See infrastructure.yaml.
metadata:
  version: "1.0.0"
  author: protclaw
  gpu: preferred
  cost-tier: fast
allowed-tools: Bash(python:*) Bash(conda:*) Read
---

# ProteinMPNN — Inverse Folding / Sequence Design

## When to Use

Call this skill when the user wants to:
- Design sequences for a given protein backbone structure
- Perform inverse folding on RFdiffusion outputs
- Sample multiple sequence variants with different temperatures
- Design sequences with backbone noise augmentation for robustness

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| pdb_files | file_list (.pdb) | Yes | — | Backbone PDB files to design sequences for |
| num_seqs_per_structure | int | | 8 | Number of sequences per backbone |
| sampling_temp | float | | 0.1 | Sampling temperature (lower = more conservative) |
| backbone_noise | float | | 0.0 | Backbone noise augmentation (0.0 = none) |
| model_name | string | | v_48_020 | Model weights variant |

## Output

- FASTA files with designed sequences (one per input PDB)

## Usage Example

```json
{
  "pdb_files": ["design_0000.pdb", "design_0001.pdb"],
  "num_seqs_per_structure": 8,
  "sampling_temp": 0.1
}
```

## Runtime Requirements

- Environment: `protclaw-mpnn` (conda, Python 3.10)
- Environment variables: `PROTEINMPNN_DIR`, `PROTEINMPNN_WEIGHTS`
- GPU: preferred (4GB+ VRAM), falls back to CPU
- Estimated runtime: 1-5 min/backbone (GPU), 10-30 min/backbone (CPU)

## Error Handling

- Missing `PROTEINMPNN_DIR` → check environment provisioning
- Invalid PDB → ensure input files are valid backbone-only PDBs
- All sequences identical → increase `sampling_temp` (try 0.2-0.3)
