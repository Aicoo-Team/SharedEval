# Datasets

Canonical benchmark assets live under `dataset/<dataset-id>/`. Runtime and
evaluation code lives under the matching `src/suites/<dataset-id>/` directory.

## Catalog

| Dataset | Version | Status |
| --- | --- | --- |
| `pact-pair` | `7.0.0` | Executable through the SharedOS file runtime |
| `pact-net` | `1.0.0` | Data, loader, workspace, and evaluator validation only |

`dataset/shared-eval/workspaces/v1/` is infrastructure rather than a benchmark
dataset. Its registry pins the four-file actor workspaces used by `multi` and
`single`.

## PACT-Pair layout

```text
dataset/pact-pair/
├── manifest.yaml
├── tasks/questions.json
├── data_spec/alex_data_store.json
├── relationship_labels/
├── policies/
├── splits/10_splits_v2/
└── agent_configs/<actor>/
    ├── AGENT.md
    ├── HEARTBEAT.md
    ├── MEMORY.md
    └── POLICY.md
```

The manifest is the source of asset paths. Consumers must not guess alternate
locations. `tasks/questions.json` contains 400 QA tasks and 200 action tasks;
`alex_data_store.json` is the canonical notes/todos state.

## Manifest contract

Every dataset manifest declares a stable `id@version`, relative asset paths,
an approved evaluator reference, and the metrics it may emit. Paths are bounded
and cannot escape the dataset root. A manifest names data only; it cannot load
code dynamically.

## Adding a dataset

1. Add a versioned asset directory and manifest.
2. Define strict schemas and loaders in a suite module.
3. Implement and register the evaluator by exact identity.
4. Add explicit catalog registration and validation tests.
5. Add execution dispatch only after the suite has a reviewed SharedOS tool
   and grant surface.

Dataset-neutral code must not learn suite-specific categories, policies, or
tool behavior. Public derived datasets are regenerated from canonical assets;
generated output never becomes a second source of truth.
