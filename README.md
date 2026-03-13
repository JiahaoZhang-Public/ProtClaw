# ProtClaw

**Protein Design Agentic System** - LLM as CPU, Agents as System, Skills as Software, Toolkits as Pluggable Scientific Capability Packs.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) + [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk).

## Architecture

ProtClaw is a three-layer system for protein design:

```
Control Plane (TypeScript)       <- NanoClaw fork: orchestration, scheduling, agent teams
Science Execution Plane (Python) <- SSH/Docker: RFdiffusion, ProteinMPNN, ESMFold, etc.
Knowledge Plane (Contracts)      <- Shared schemas: ProjectSpec, DesignPlan, Artifacts, Evidence
```

### V1 Golden Path: De Novo Protein Design

```
backbone_generate (RFdiffusion)
  -> sequence_design (ProteinMPNN)
    -> structure_predict (ESMFold)
      -> structure_qc + developability_check
        -> candidate_cluster -> candidate_rank
          -> experiment_package
            -> [wet lab] -> feedback -> replan (DBTL loop)
```

## Repository Structure

```
protclaw/
├── apps/
│   └── orchestrator/          # NanoClaw fork - TypeScript control plane
│       ├── src/               # Host process (orchestrator, IPC, scheduler, channels)
│       ├── container/         # Agent container (Claude Agent SDK + MCP tools)
│       └── agent-roles/       # Agent role templates
├── packages/
│   └── contracts/             # Shared domain contracts (JSON Schema -> TS + Python)
│       ├── schemas/           # JSON Schema source of truth
│       ├── src/               # TypeScript types + Zod validators
│       └── python/            # Pydantic v2 models
├── workers/
│   └── science-python/        # Python science execution plane
│       ├── common/            # Tool adapter protocol + container entrypoint
│       └── tools/             # Per-tool adapters (7 skills)
├── toolkits/
│   └── de-novo/               # De novo design toolkit manifest
└── projects/                  # Runtime project workdir (gitignored)
```

## Skills

Each skill follows the **Agent Skills Standard**: a self-contained directory with `SKILL.md` (metadata + params) + `infrastructure.yaml` (conda env + deps) + `adapter.py` (execution logic).

| Skill | Tool | Compute | Description |
|-------|------|---------|-------------|
| `rfdiffusion` | RFdiffusion | GPU | Backbone generation via diffusion |
| `proteinmpnn` | ProteinMPNN | GPU | Sequence design for given backbone |
| `esmfold` | ESMFold | GPU | Structure prediction from sequence |
| `structure-qc` | PyRosetta metrics | CPU | RMSD, clash score, Ramachandran QC |
| `developability` | BioPython analysis | CPU | Aggregation propensity, charge, MW |
| `candidate-ops` | Clustering + ranking | CPU | Candidate clustering and multi-objective ranking |
| `experiment-package` | Report generation | CPU | Order sheets + HTML reports for wet lab |

Skills are located at `workers/science-python/tools/<skill_name>/`.

## CLI Usage

### Run a single skill

```bash
cd apps/orchestrator
npx tsx src/protclaw-cli.ts run-skill rfdiffusion \
  --params '{"contigs": "50-50", "num_designs": 1}'
```

### Run the full de novo pipeline

```bash
npx tsx src/protclaw-cli.ts run-pipeline de-novo \
  --params '{"contigs": "50-50", "num_designs": 1}'
```

The pipeline automatically:
1. Routes output files between steps by format convention (`.pdb` → `pdb_files`, `.fasta` → `fasta_files`)
2. Injects upstream metrics (`_upstream_results`) for JSON-to-JSON transitions
3. Manages per-node workdirs under a pipeline-level directory

### Target configuration

Create `.protclaw/targets.yaml` from the example:

```bash
cp .protclaw/targets.yaml.example .protclaw/targets.yaml
# Edit with your SSH host, GPU count, paths, etc.
```

See `.protclaw/targets.yaml.example` for full configuration reference.

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for agent containers) or SSH access to a GPU server
- Python >= 3.10 (for science workers)
- Conda environments on the target server (see `tools/setup-gpuhub.sh`)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Run the orchestrator in dev mode
cd apps/orchestrator && pnpm dev
```

## Agent Roles (V1)

| Role | Responsibility |
|------|---------------|
| Principal Scientist | Manages ProjectSpec, creates DesignPlan, orchestrates campaign |
| Program Manager | Tracks execution, manages resources and budget |
| Toolkit Specialist | Executes individual tool operations |
| Evidence Reviewer | Analyzes quality metrics, makes go/no-go decisions |
| DBTL Reflection | Analyzes experiment feedback, proposes replans |

## License

MIT
