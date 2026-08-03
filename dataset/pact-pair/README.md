# PACT-Pair

PACT-Pair is the canonical paired benchmark for privacy-aware question answering and state-changing actions across notes and todos.

- `tasks/questions.json` contains the versioned QA and action task set.
- `data_spec/alex_data_store.json` is the canonical workspace seed.
- `relationship_labels/relationship_label_matrix.json` contains requester-conditioned labels.
- `policies/` contains the benchmark policy profiles.
- `splits/10_splits_v2/` contains the current ten-split release.

`manifest.yaml` declares the dataset assets and approved evaluator. Runtime implementation code lives in `src/suites/pact-pair/`.
