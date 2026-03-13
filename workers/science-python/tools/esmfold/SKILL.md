---
name: esmfold
description: >
  Protein structure prediction from amino acid sequence using ESMFold. Use after
  sequence design (ProteinMPNN) to validate that designed sequences fold into the
  intended structure. Returns predicted PDB with pLDDT and pTM confidence scores.
compatibility: >
  Requires conda, GPU recommended (CUDA/MPS/CPU). Needs openfold patches for
  PyTorch 2.x compatibility. See infrastructure.yaml and scripts/patches/.
metadata:
  version: "1.0.0"
  author: protclaw
  gpu: preferred
  cost-tier: balanced
allowed-tools: Bash(python:*) Bash(conda:*) Read
---

# ESMFold — Structure Prediction

## When to Use

Call this skill when the user wants to:
- Predict 3D structure from amino acid sequences
- Validate designed sequences fold correctly (after ProteinMPNN)
- Get confidence scores (pLDDT, pTM) for designed proteins
- Quick structure prediction without MSA (faster than AlphaFold2)

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| fasta_files | file_list (.fasta) | | — | FASTA files with sequences to predict |
| sequences | object | | — | Dict of {name: sequence} pairs (alternative to fasta_files) |
| num_recycles | int | | 4 | Number of recycling iterations (more = better but slower) |
| chunk_size | int | | — | Set to 64 if running out of GPU memory |

Provide either `fasta_files` or `sequences`, not both.

## Output

- Predicted structure PDB files (one per sequence)
- Metrics: avg_plddt, avg_ptm per prediction

## Usage Example

```json
{
  "sequences": {
    "design_0000_seq1": "MKLLVVLGFLIFSYSGA..."
  },
  "num_recycles": 4
}
```

## Runtime Requirements

- Environment: `protclaw-esmfold` (conda, Python 3.10)
- Environment variable: `HF_HOME` (HuggingFace cache for model weights)
- GPU: preferred (8GB+ VRAM, 16GB recommended for longer sequences)
- Estimated runtime: 1-10 min/sequence (GPU), 30-60 min/sequence (CPU)
- Model weights: ~2.5GB (auto-downloaded from HuggingFace on first run)
- Max sequence length: ~500 residues on 8GB GPU, ~1500 on 24GB GPU

## Environment Patches

ESMFold requires openfold, which has CUDA compilation issues on modern PyTorch.
The infrastructure.yaml references 5 patches in `scripts/patches/`:
1. `openfold-install.sh` — Lazy-load openfold (skip CUDA kernel compilation)
2. `openfold-attention.sh` — Pure PyTorch attention (replace CUDA kernel)
3. `openfold-structure-module.sh` — Handle missing attn_core_inplace_cuda
4. `openfold-deepspeed.sh` — Fix deepspeed.utils.is_initialized compatibility
5. `torch-six-shim.sh` — torch._six compatibility shim for PyTorch 2.x

## Error Handling

- CUDA OOM → set `chunk_size: 64` or reduce sequence length
- openfold import error → verify patches were applied during provisioning
- Model download failure → check `HF_HOME` path and network access
- MPS mode → use `model.float()` (MPS doesn't support fp16), max ~500 residues
