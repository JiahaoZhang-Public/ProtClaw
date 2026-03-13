---
name: rfdiffusion
description: >
  Protein backbone generation via RFdiffusion diffusion model. Use when designing
  new protein structures from contig specifications. Supports de novo design,
  scaffold-guided design with partial diffusion, and constrained generation with
  input PDB templates.
compatibility: Requires conda, GPU recommended (CUDA/MPS/CPU). See infrastructure.yaml.
metadata:
  version: "1.1.0"
  author: protclaw
  gpu: preferred
  cost-tier: balanced
allowed-tools: Bash(python:*) Bash(conda:*) Read
---

# RFdiffusion — Protein Backbone Generation

## When to Use

Call this skill when the user wants to:
- Generate de novo protein backbones from contig specifications
- Perform scaffold-guided design with partial diffusion (partial_T)
- Create multiple backbone designs in batch
- Design binders or constrained structures with input PDB

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| contigs | string | Yes | — | Contig specification (e.g. `100-100` for 100-residue chain, `50-50/A1-50` for binder) |
| num_designs | int | | 1 | Number of backbone designs to generate (1-1000) |
| noise_scale | float | | 1.0 | Noise scale for diffusion (both CA and frame) |
| partial_T | int | | — | Partial diffusion timesteps for scaffold-guided design |
| input_pdb | file (.pdb) | | — | Template PDB for constrained generation (place in input_dir) |

## Output

- `design_*.pdb` — Generated backbone PDB files in output directory

## Usage Example

```json
{
  "contigs": "100-100",
  "num_designs": 4,
  "noise_scale": 1.0
}
```

Scaffold-guided example:
```json
{
  "contigs": "50-50/A1-50",
  "partial_T": 20,
  "num_designs": 8
}
```

## Runtime Requirements

- Environment: `protclaw-rfdiffusion` (conda, Python 3.10)
- Environment variables: `RFDIFFUSION_DIR`, `RFDIFFUSION_WEIGHTS`
- GPU: preferred (8GB+ VRAM), falls back to CPU
- Estimated runtime: 5-30 min/design (GPU), 2-8 hours/design (CPU)
- Model weights: ~1.6GB (Base + Complex checkpoints)

## Error Handling

- Missing inference script → check `RFDIFFUSION_DIR` is set and repo is cloned
- Timeout after 3600s → reduce num_designs or check GPU availability
- No PDB files in output → examine RFdiffusion stdout for hydra/config errors
- CUDA OOM → reduce contig length or use `noise_scale_ca=0` for partial runs
