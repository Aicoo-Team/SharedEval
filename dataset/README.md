# Benchmark datasets

This directory is the canonical home for versioned public PACT-Bench dataset
assets. Each child directory contains one dataset manifest and its supporting
data; dataset-specific runtime code lives under `src/suites/`.

## Catalog

| ID | Version | Description | Entry point |
| --- | --- | --- | --- |
| `pact-pair` | `6.0.0` | Paired privacy-aware QA and delegated actions over notes and todos | [`pact-pair/manifest.yaml`](pact-pair/manifest.yaml) |
| `pact-net` | `1.0.0` | 25-agent network benchmark with relational access labels, QA, and actions | [`pact-net/manifest.yaml`](pact-net/manifest.yaml) |

For PACT-Pair, use `pact-pair/tasks/questions.json` as the task source of truth.
The legacy `pact_pair/` location has moved here; consumers should not maintain a
fallback copy or treat both paths as canonical.

## Boundaries

- Keep source assets, release metadata, policies, and public split definitions
  in the dataset's own directory.
- Keep loaders, schemas, prompts, tools, and evaluators in
  `src/suites/<dataset-id>/`.
- Keep local configs, generated runs, model traces, credentials, and caches out
  of this directory.
- Keep held-out official tasks, labels, evaluator state, and private traces out
  of this repository entirely.
- Generate public mirrors, including Hugging Face JSONL, from these assets; do
  not edit a mirror as an alternate source of truth.

The manifest format and extension process are documented in
[`docs/datasets.md`](../docs/datasets.md). The overall runtime boundary is in
[`docs/architecture.md`](../docs/architecture.md).
