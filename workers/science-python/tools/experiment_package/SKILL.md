---
name: experiment-package
description: >
  Generate experiment order sheets (Excel) and summary reports (HTML) for top-ranked
  protein candidates. Use as the final step in the de novo design pipeline to produce
  deliverables for wet-lab scientists.
compatibility: CPU-only. Requires conda with openpyxl, jinja2. See infrastructure.yaml.
metadata:
  version: "1.0.0"
  author: protclaw
  gpu: none
  cost-tier: fast
allowed-tools: Bash(python:*) Read
---

# Experiment Package — Order Sheets & Reports

## When to Use

Call this skill when the user wants to:
- Generate Excel order sheets for gene synthesis
- Create HTML summary reports of the design campaign
- Package top candidates with sequences, scores, and metadata for wet-lab

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| candidates | array | Yes | — | Ranked candidates with sequence, scores, metadata |
| project_name | string | | "ProtClaw Design" | Project name for report header |
| scientist_name | string | | "" | Scientist name for order sheet |
| top_n | int | | 10 | Number of top candidates to include |
| include_report | boolean | | true | Whether to generate HTML summary report |

## Output

- `order_sheet.xlsx` — Excel file with sequences, scores, synthesis-ready format
- `summary_report.html` — Visual HTML report (if include_report=true)

## Usage Example

```json
{
  "candidates": [...],
  "project_name": "Nanobody Design Campaign",
  "scientist_name": "Dr. Zhang",
  "top_n": 10,
  "include_report": true
}
```

## Runtime Requirements

- Environment: `protclaw-cpu` (shared)
- GPU: none (CPU-only)
- Estimated runtime: < 1 min
