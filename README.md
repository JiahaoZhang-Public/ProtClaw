# ProtClaw

**Protein Design Agentic System** - LLM as CPU, Agents as System, Skills as Software, Toolkits as Pluggable Scientific Capability Packs.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) + [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk).

## Architecture

ProtClaw is a three-layer system for protein design:

```
Control Plane (TypeScript)       <- NanoClaw fork: orchestration, scheduling, agent teams
Science Execution Plane (Python) <- Docker containers: RFdiffusion, ProteinMPNN, ESMFold, etc.
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
│       └── agent-roles/       # Agent role templates (to be added)
├── packages/
│   └── contracts/             # Shared domain contracts (JSON Schema -> TS + Python)
│       ├── schemas/           # JSON Schema source of truth
│       ├── src/               # TypeScript types + Zod validators
│       └── python/            # Pydantic v2 models
├── workers/
│   └── science-python/        # Python science execution plane
│       ├── common/            # Tool adapter protocol + container entrypoint
│       ├── base/              # Base Docker image
│       └── tools/             # Per-tool adapters and Dockerfiles
├── toolkits/
│   └── de-novo/               # De novo design toolkit manifest
└── projects/                  # Runtime project workdir (gitignored)
```

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for agent containers and science tools)
- Python >= 3.10 (for science workers)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

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
