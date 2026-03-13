# Changelog

All notable changes to ProtClaw are documented in this file.

## [0.1.0] - 2025-03-13

**CLI Pipeline Execution** — First functional milestone.

### Added

- **CLI entry point** (`protclaw-cli.ts`): `run-skill` for single skill execution, `run-pipeline` for full DAG execution
- **7 science skill adapters** with real implementations:
  - `rfdiffusion` — backbone generation via RFdiffusion
  - `proteinmpnn` — sequence design via ProteinMPNN
  - `esmfold` — structure prediction via ESMFold (with OpenFold patches)
  - `structure-qc` — RMSD, clash score, Ramachandran analysis
  - `developability` — aggregation propensity, charge, molecular weight
  - `candidate-ops` — clustering (k-means) and multi-objective ranking
  - `experiment-package` — order sheet (XLSX) and HTML report generation
- **Agent Skills Standard**: each skill is a self-contained directory with `SKILL.md` (metadata + params), `infrastructure.yaml` (conda env + deps), `adapter.py` (execution logic)
- **SkillRegistry**: loads skills from `SKILL.md` frontmatter + `infrastructure.yaml`, resolves conda envs and repo paths
- **ExecutionEngine**: `LocalExecutionEngine` (subprocess) and `SshExecutionEngine` (SSH + conda) with automatic adapter module resolution (kebab→underscore conversion)
- **DagExecutor**: topological DAG execution with ResourceScheduler-based GPU/CPU slot management
- **Pipeline file routing**: convention-based output→input file copying between DAG nodes (`.pdb` → `pdb_files`, `.fasta` → `fasta_files`)
- **Upstream result injection**: `_upstream_results` dict passed to downstream nodes for JSON-to-JSON metric aggregation
- **ResourceScheduler**: auto-infers GPU/CPU concurrency from target hardware (4GPU→3 GPU slots, 1GPU→serial, CPU-only→fallback)
- **Target configuration** (`.protclaw/targets.yaml`): SSH host, GPU count, conda paths, scheduling overrides
- **Provisioner**: validates conda envs and git repos exist on target, with auto-fix capabilities
- **De novo toolkit manifest** (`toolkits/de-novo/manifest.yaml`): 8-operation pipeline definition with dependency graph
- **ExecutionDispatcher + AuditLogger**: async plan execution with file-based audit trail
- **DBTL loop**: feedback ingestion, learning analysis, constraint-aware replanning
- **Setup script** (`tools/setup-gpuhub.sh`): automated conda env + repo provisioning for GPU servers

### Verified

- Full 8-step de novo pipeline on GPUHub (4× RTX 4080 SUPER, ~96s total):
  RFdiffusion (37s) → ProteinMPNN (3.5s) → ESMFold (55s) → Structure QC → Developability → Cluster → Rank → Experiment Package
- 361 TypeScript tests (vitest), 60 Python tests (pytest)
