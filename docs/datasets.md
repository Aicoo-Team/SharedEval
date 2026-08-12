# Datasets

Public benchmark assets live under `dataset/<dataset-id>/`. Each dataset owns a
versioned manifest and a self-contained asset tree; runtime code lives in the
matching suite under `src/suites/<dataset-id>/`.

## Current catalog

| Dataset | Manifest version | Protocol | Runtime status |
| --- | --- | --- | --- |
| `pact-pair` | `6.0.0` | `pact-bench/v1` | Built-in local runner and protocol-v1 suite |
| `pact-net` | `1.0.0` | `pact-bench/v1` | Dataset assets only; no runtime suite yet |

The canonical PACT-Pair root is `dataset/pact-pair/`. The former top-level
`pact_pair/` location is not a second source of truth.

## Directory contract

```text
dataset/
├── README.md
└── pact-pair/
    ├── manifest.yaml
    ├── README.md
    ├── tasks/questions.json
    ├── data_spec/alex_data_store.json
    ├── relationship_labels/relationship_label_matrix.json
    ├── policies/
    └── splits/10_splits_v2/
```

For PACT-Pair, the task JSON declares 600 tasks: 200 Notes QA, 200 Todo QA, and
200 Actions. `tasks/questions.json`, not the archived
`tasks/gold_answers_legacy.*` files, is authoritative. The workspace seed and
requester-conditioned label matrix are separate assets because they have a
different lifecycle and must not be copied into adapter-facing task objects.

The current ten-way split family is `splits/10_splits_v2/`, as named by the
manifest. Older split files may remain for provenance, but consumers should
resolve the manifest's `assets.splits` entry rather than guessing a directory.

## Manifest contract

`manifest.yaml` is validated against `pact-bench/dataset/v1` and contains:

| Field | Contract |
| --- | --- |
| `id`, `name`, `version` | Stable dataset identity and semantic release version |
| `protocol` | Public protocol the dataset is designed to exercise |
| `assets` | Named, relative paths beneath the dataset root |
| `evaluation.evaluator` | Exact approved evaluator `id@version` reference |
| `evaluation.metrics` | Unique metric names the evaluator may contribute |

The asset map is intentionally flexible so different datasets do not need to
pretend they have PACT-Pair's tasks, workspace, policy, or split structure.
Consumers must validate required asset names for their suite and resolve paths
beneath the selected dataset root. A manifest cannot name executable code.

## Adding a dataset

Adding a directory is necessary but not sufficient to make a dataset runnable:

1. Choose a lowercase stable ID and create `dataset/<id>/manifest.yaml` plus
   the public, versioned assets.
2. Define suite-specific schemas and loaders under `src/suites/<id>/`. Validate
   counts, identifiers, references, and any split invariants at the boundary.
3. Implement an evaluator that returns only the metrics declared by the
   manifest. Register its exact `id@version` in the host-owned approved
   evaluator registry.
4. Register the parsed dataset definition by exact dataset `id@version`.
5. Add explicit runner dispatch and config validation for the new dataset.
   Dataset discovery must not dynamically import code.
6. Add fixture, schema, loader, evaluator, aggregation, and end-to-end tests.
7. Document the public/private boundary and create a deterministic derived
   release process if the dataset will be mirrored elsewhere.

Do not make dataset-neutral code understand suite-specific categories, policy
dials, tools, or score details. The generic layer should deal in validated
manifests, evaluator references, contributions, and aggregates; the suite owns
their meaning.

## Source, derivative, and private artifacts

- **Canonical public source:** versioned files under `dataset/<id>/`.
- **Derived public artifacts:** generated representations such as the Hugging
  Face JSONL staging tree. Regenerate these from canonical assets and record
  hashes; do not edit them as a competing source of truth.
- **Local run artifacts:** configs, model traces, and reports. Keep them out of
  the dataset tree.
- **Private official evaluation:** held-out tasks, labels, evaluator state,
  credentials, and private traces. Store and operate these in a separate
  access-controlled system, never under `dataset/` and never in a public mirror.

See [Multi-dataset architecture](architecture.md) for the runtime boundaries
and [Hugging Face export](huggingface.md) for the public mirror contract.
