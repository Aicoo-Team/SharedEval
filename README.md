# PACT-Bench

PACT-Bench is a benchmark suite for evaluating whether agent systems can
coordinate across ownership boundaries while preserving privacy, relationship
constraints, and task utility.

The repository is maintained as the public, multi-dataset benchmark contract.
It separates versioned assets under `dataset/`, executable benchmark code under
`src/`, and dataset-neutral evaluation infrastructure. Private leaderboard
labels, unreleased run artifacts, and product-coupled Aicoo adapters live
outside this repository.

## Suites

### PACT-Pair

PACT-Pair is the dyadic unit test: one requester agent asks one target agent for
information or actions across a single privacy boundary.

| Component | Path | Description |
| --- | --- | --- |
| Manifest | `dataset/pact-pair/manifest.yaml` | Dataset identity, assets, evaluator, and metrics |
| Tasks | `dataset/pact-pair/tasks/questions.json` | 400 QA tasks plus 200 action tasks |
| Data store | `dataset/pact-pair/data_spec/alex_data_store.json` | Synthetic notes and todos for the target user |
| Runtime | `src/suites/pact-pair/` | Pair-specific loading, tools, workspace, and scoring |

### PACT-Net

- [ ] PACT-Net — to be released

## Quick Start

```bash
npm install
npm run validate
npm run validate:sample
npm run smoke:sample
npm run smoke:pact-pair
npm run export:huggingface:pact-pair
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

- a strict dataset manifest and approved-runtime registry for multiple dataset families;
- generic evaluator registration, metric validation, and aggregation;
- public synthetic task files and the first built-in suite, PACT-Pair;
- deterministic Hugging Face staging for PACT-Pair (`pair` / `validation`);
- a strict PACT-Pair Adapter Protocol v1 contract and manifest parser;
- a JSON-RPC adapter host, secure bundle validator, and executable TypeScript starter;
- a dataset-dispatching runner with a PACT-Pair OpenAI-compatible BYOK adapter;
- an isolated in-memory notes/todos world, deterministic evaluator, and run reports;
- benchmark design documentation;
- submission, metrics, and leaderboard documentation.

The local runner is self-contained and does not import Pulse or require an
Aicoo account. The older experiment scripts directly under `scripts/` are
legacy/internal Pulse references; `scripts/huggingface/` is a standalone public
exporter.

## Submissions

There are two separate workflows:

- `pact-run.yaml` configures a local BYOK benchmark run against a model API.
- `pact.yaml` describes a runnable agent artifact that implements the Adapter
  Protocol for reproducible evaluation.

This repository defines both local contracts, but it does not deploy a hosted
submission API. Aicoo is the intended product surface for authenticated dataset
and result intake; PACT remains the versioned data, execution, and evaluation
contract. See the
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
- [Multi-dataset architecture](docs/architecture.md)
- [Dataset manifests and extensions](docs/datasets.md)
- [Hugging Face export](docs/huggingface.md)
- [PACT-Pair post-hoc evaluation tools](docs/pact-pair-evaluation-tools.md)
- [Submission format](docs/submission_format.md)
- [Metrics](docs/metrics.md)
- [Leaderboard policy](docs/leaderboard.md)
- [PACT-Pair data](dataset/pact-pair/BENCHMARK_DATA.md)

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
