# SharedEval

SharedEval is a benchmark control plane for evaluating collaboration between
agents. SharedOS is its execution plane.

The boundary is strict:

- every requester and responder turn runs through SharedOS;
- every model-visible file or benchmark tool is discovered and authorized by
  SharedOS;
- every agent request and reply is authorized by SharedOS;
- SharedEval schedules runs, stores durable state, selects benchmark tasks,
  scores outcomes, and writes artifacts.

## Supported surface

SharedEval exposes two workflows:

- `multi`: one run-scoped session processes an ordered task set;
- `single`: every task receives an isolated session.

PACT-Pair is the executable benchmark suite. PACT-Net remains available for
data and evaluator validation, but is not an execution target in this release.

## Quick start

```bash
npm ci
npm run validate
npm run smoke:pact-pair
npm run smoke:pact-net
npm run export:huggingface:pact-pair
npm test
npm run type-check
```

Validate a run configuration without calling a model or SharedOS:

```bash
npm run sharedeval -- --config sharedeval-run.yaml --check
npm run sharedeval -- multi --config sharedeval-run.yaml --check
npm run sharedeval -- single --config sharedeval-run.yaml --check
```

Omitting the command mode selects `multi`. Explicit command mode and
`workflow.mode` in the configuration must agree. See
[the running guide](docs/running.md) for the configuration shape and execution
commands.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/execution/sharedos/` | Verified dynamic boundary to the pinned SharedOS build |
| `src/runner/` | Scheduling, durable host state, model driver, and artifacts |
| `src/suites/` | Benchmark-specific loading, tools, workspaces, and scoring |
| `src/datasets/` | Dataset manifest and catalog validation |
| `dataset/` | Canonical public benchmark and workspace assets |
| `scripts/huggingface/` | Deterministic public dataset export |

## SharedOS pin

The production boundary is verified against SharedOS revision
`ac0f1bb210baa3ba4b7e0d0baaf2291bbe9ffd05` and the four-package runtime digest
`849c121d18a3f2a9ddcc3c704d0bed7f3f64f0738395fa8c53ff46be918f0473`.
SharedEval loads only SharedOS contracts, core, OS tools, and runtime packages;
an unavailable or mismatched build fails before model spend.

## Documentation

- [Running SharedEval](docs/running.md)
- [Architecture](docs/architecture.md)
- [Datasets](docs/datasets.md)
- [PACT-Pair data](dataset/pact-pair/BENCHMARK_DATA.md)
- [PACT-Pair evaluation tools](docs/pact-pair-evaluation-tools.md)
- [Hugging Face export](docs/huggingface.md)
- [Metrics](docs/metrics.md)

## License

MIT. All benchmark data in this repository is synthetic.
