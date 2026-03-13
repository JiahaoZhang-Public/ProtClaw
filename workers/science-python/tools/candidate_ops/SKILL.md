---
name: candidate-ops
description: >
  Candidate clustering (k-means) and multi-objective Pareto ranking. Use after
  developability assessment to cluster similar candidates and rank them by multiple
  criteria (pLDDT, RMSD, developability scores) for final selection.
compatibility: CPU-only. Requires conda with scikit-learn. See infrastructure.yaml.
metadata:
  version: "1.0.0"
  author: protclaw
  gpu: none
  cost-tier: fast
allowed-tools: Bash(python:*) Read
---

# Candidate Ops — Clustering & Ranking

## When to Use

Call this skill when the user wants to:
- Cluster protein candidates by structural/sequence features (k-means)
- Rank candidates using multi-objective Pareto optimization
- Select diverse representatives from a large candidate pool

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| mode | string | Yes | — | `cluster` or `rank` |
| candidates | object | Yes | — | List of candidate dicts with scores/features |
| feature_keys | array | | — | Feature keys for clustering (cluster mode) |
| n_clusters | int | | 5 | Number of clusters (cluster mode) |
| rank_objectives | array | | — | Objective names for ranking (rank mode) |
| rank_directions | array | | — | `max` or `min` per objective (rank mode) |

## Output

- `results.json` — Clustered or ranked candidates

## Usage Examples

Clustering:
```json
{
  "mode": "cluster",
  "candidates": [...],
  "feature_keys": ["plddt", "rmsd", "mw"],
  "n_clusters": 5
}
```

Pareto ranking:
```json
{
  "mode": "rank",
  "candidates": [...],
  "rank_objectives": ["plddt", "rmsd", "aggregation_score"],
  "rank_directions": ["max", "min", "min"]
}
```

## Runtime Requirements

- Environment: `protclaw-cpu` (shared)
- GPU: none (CPU-only)
- Estimated runtime: < 1 min
