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

- [ ] PACT-Net — to be released

## Quick Start

```bash
npm install
npm run validate
npm run validate:sample
npm run smoke:sample
npm run smoke:pact-pair
npm test
npm run type-check
```

`npm run validate` checks the public benchmark assets against the TypeScript/Zod
schemas in `src/` and parses the canonical protocol manifest. The dedicated
sample commands validate its bundle and exercise the adapter lifecycle.

To run PACT-Pair against your own OpenAI-compatible model API:

```bash
export PACT_MODEL_API_KEY="your-provider-key"
npm run benchmark -- --config examples/pact-run.openai-compatible.yaml
```

The YAML contains the model name, base URL, task selection, and the dedicated
`PACT_MODEL_API_KEY` credential alias. It never contains the key itself.
See [Running PACT locally](docs/running.md) for the complete configuration and
output contract.

## Current Status

This repository currently provides:

- public synthetic task files for PACT-Pair;
- schema validation for the benchmark data;
- a strict PACT-Pair Adapter Protocol v1 contract and manifest parser;
- a JSON-RPC adapter host, secure bundle validator, and executable TypeScript starter;
- a standalone PACT-Pair runner with an OpenAI-compatible BYOK model adapter;
- an opt-in six-task Harbor/Docker parity backend (local remains the default);
- an isolated in-memory notes/todos world, deterministic evaluator, and run reports;
- benchmark design documentation;
- submission, metrics, and leaderboard documentation.

The local runner is self-contained and does not import Pulse or require an
Aicoo account. The existing scripts under `scripts/` are legacy/internal
references and still depend on Pulse application modules.

## Submissions

There are two separate workflows:

- `pact-run.yaml` configures a local BYOK benchmark run against a model API.
- `pact.yaml` describes a runnable agent artifact that implements the Adapter
  Protocol for reproducible evaluation.

This repository defines both local contracts, but it does not define or deploy
a hosted submission API. Aicoo can host benchmark intake later without coupling
that product API to the public benchmark specification. See the
[submission format](docs/submission_format.md) for the artifact contract.

## Evaluation Dimensions

| Dimension | PACT-Pair measurement |
| --- | --- |
| Information utility | Legitimate QA is answered correctly |
| Information security | Sensitive QA does not leak protected gold facts |
| Action utility | Authorized mutations execute correctly |
| Action safety | Unauthorized mutations are refused or produce no state change |

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

- [Running PACT locally](docs/running.md)
- [Submission format](docs/submission_format.md)
- [Metrics](docs/metrics.md)
- [Leaderboard policy](docs/leaderboard.md)
- [PACT-Pair data](pact_pair/BENCHMARK_DATA.md)

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
