# PACT-Bench

PACT-Bench is a benchmark suite for evaluating whether agent systems can
coordinate across ownership boundaries while preserving privacy, relationship
constraints, and task utility.

The repository is maintained as the public benchmark contract. It contains
synthetic worlds, task files, schemas, documentation, and baseline-facing
interfaces. Private leaderboard labels, unreleased run artifacts, and
product-coupled Aicoo/Pulse adapters should live outside this repository.

## Suites

### PACT-Pair

PACT-Pair is the dyadic unit test: one requester agent asks one target agent for
information or actions across a single privacy boundary.

| Component | Path | Description |
| --- | --- | --- |
| Tasks | `pact_pair/tasks/questions.json` | 400 QA tasks plus 200 action tasks |
| Data store | `pact_pair/data_spec/alex_data_store.json` | Synthetic notes and todos for the target user |
| Policies | `pact_pair/policies/` | D0-D5 policy and defense prompts |
| Relationship labels | `pact_pair/relationship_labels/` | Requester-conditioned labels |
| Splits | `pact_pair/splits/` | Pre-computed multi-step task splits |

### PACT-Net

PACT-Net is the network integration test: 25 agents coordinate across a contact
graph with requester-conditioned access labels.

| Component | Path | Description |
| --- | --- | --- |
| Tasks | `pact_net/pact_net_tasks.json` | 483 QA tasks plus 514 action tasks |
| World design | `pact_net/world_design/` | Contact graph, access matrix, and task allocation |
| Agent configs | `pact_net/agent_configs/` | Synthetic identities, policies, and data stores |
| Design docs | `pact_net/PACT_NET_DESIGN.md` | Benchmark rationale and planned evaluation |

## Quick Start

```bash
npm install
npm run validate
npm run smoke:pact-pair
npm run smoke:pact-net
npm run type-check
```

`npm run validate` checks the public JSON assets against the TypeScript/Zod schemas
in `src/`.

## Current Status

This repository currently provides:

- public synthetic task files for PACT-Pair and PACT-Net;
- schema validation for the benchmark data;
- benchmark design documentation;
- submission, metrics, and leaderboard documentation.

The full Aicoo/Pulse DB-backed runner is not yet a public dependency. The
existing scripts under `scripts/` are legacy/internal references and still depend
on Pulse application modules. Public runner and adapter packages should be added
behind the contracts in this repo instead of importing Pulse internals.

## Evaluation Dimensions

| Dimension | PACT-Pair | PACT-Net |
| --- | --- | --- |
| Information utility | Legitimate QA answered correctly | Legitimate requester-conditioned QA answered correctly |
| Information security | Sensitive QA does not leak gold facts | Private or transitive facts do not leak |
| Action utility | Authorized mutations execute correctly | Authorized cross-agent mutations execute correctly |
| Action safety | Unauthorized mutations are refused/no-op | Unauthorized, confused-deputy, and laundering actions are blocked |

See [docs/metrics.md](docs/metrics.md) for the metric definitions.

## Repository Boundary

Public benchmark repository:

- schemas and task formats;
- public smoke tasks and synthetic worlds;
- baseline interfaces;
- sanitized result summaries;
- documentation for submissions and metrics.

Private research or product repositories:

- hidden evaluation sets;
- private gold labels for official leaderboard runs;
- raw traces from unreleased experiments;
- product adapters that require Aicoo/Pulse secrets or production databases.

## Documentation

- [Submission format](docs/submission_format.md)
- [Metrics](docs/metrics.md)
- [Leaderboard policy](docs/leaderboard.md)
- [PACT-Pair data](pact_pair/BENCHMARK_DATA.md)
- [PACT-Net design](pact_net/PACT_NET_DESIGN.md)

## Citation

Formal citation metadata will be added with the first public technical report.
For now, cite the repository directly:

```bibtex
@misc{pactbench2026,
  title = {PACT-Bench: Cross-Boundary Agent Privacy and Delegation Benchmark},
  author = {Wang, Xisen},
  year = {2026},
  howpublished = {\url{https://github.com/xisen-w/PACT}}
}
```

## License

MIT. All benchmark data in this repository is synthetic.
