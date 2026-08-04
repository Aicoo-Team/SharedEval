# Hugging Face export

The recommended Hugging Face family repository is `ORG/PACT-Bench`, with one
configuration per PACT dataset. The current public release uses configuration
`pair` and split `validation`.

This repository provides a local staging exporter. It performs no login,
network request, repository creation, commit, or upload.

## Public release contract

| Dimension | Recommendation |
| --- | --- |
| Dataset repository | `ORG/PACT-Bench` |
| Configuration | `pair` |
| Public split | `validation` |
| Rows | 600, one per canonical PACT-Pair task |
| Track representation | `track` column: `notes_qa`, `todo_qa`, or `actions` |
| Official tests | Separate private system; never export to the Hub |
| Consumer versioning | Pin an immutable full Hugging Face commit SHA |

Calling the released data `validation` makes its role explicit: labels are
public and repeated development against them can overfit. An official `test`
split must not be added later as an empty promise or as encrypted/obfuscated
files in the same public repository. Hidden official tasks, labels, evaluator
state, traces, and access credentials belong in a separately controlled
evaluation service.

## Create a staging tree

From the PACT-Bench repository root:

```bash
node scripts/huggingface/export-pact-pair.mjs --check
node scripts/huggingface/export-pact-pair.mjs \
  --output /tmp/PACT-Bench
```

The exporter reads:

- `dataset/pact-pair/tasks/questions.json`;
- `dataset/pact-pair/relationship_labels/relationship_label_matrix.json`;
- `dataset/pact-pair/data_spec/alex_data_store.json`.

It validates the task ranges, counts, unique IDs, category-policy metadata,
requester labels, and world counts before writing. The result is staged
atomically and contains no timestamp or local absolute path:

```text
/tmp/PACT-Bench/
├── README.md
├── assets/pair/alex_data_store.json
├── data/pair/validation.jsonl
└── export-manifest.json
```

`README.md` is a dataset card with the YAML `configs` declaration understood by
the Hugging Face Dataset Viewer. JSON Lines is used because Hugging Face's JSON
loader treats one object per line as rows, and it avoids adding a Parquet build
dependency to this repository. See the official documentation for
[data-file configuration](https://huggingface.co/docs/hub/datasets-data-files-configuration),
[dataset cards](https://huggingface.co/docs/hub/datasets-cards), and
[JSON loading](https://huggingface.co/docs/datasets/en/loading).

## Row schema

All three tracks use the same column types. A field that does not apply is
`null` or an empty list, avoiding inference-dependent object unions.

| Group | Columns |
| --- | --- |
| Identity | `task_id`, `numeric_id`, `benchmark_version`, `config`, `split`, `track`, `kind` |
| Public task | `prompt`, `category`, `surface`, `operation`, `topic`, `target_item`, `target_folder` |
| QA sources and gold | `source_notes`, `source_todos`, `gold_key_facts`, `minimum_correct` |
| Policy labels | `expected_policy_d0` through `expected_policy_d5` |
| Relationship labels | `relationship_r0` through `relationship_r4` (`L`, `P`, `B`, or null) |
| Action gold | `expected_verdict` and flattened `gold_check_*` columns |
| Companion data | `world_asset`, pointing to the single copied synthetic workspace JSON |

The row order is deterministic: Notes QA by numeric ID, Todo QA by numeric ID,
then Actions by numeric ID. `export-manifest.json` records the complete column
schema, counts, canonical source hashes, and generated artifact hashes.

## Verify a candidate release

Generate two independent staging trees from the same source revision and
compare them:

```bash
node scripts/huggingface/export-pact-pair.mjs --output /tmp/pact-hf-a
node scripts/huggingface/export-pact-pair.mjs --output /tmp/pact-hf-b
diff -ru /tmp/pact-hf-a /tmp/pact-hf-b
wc -l /tmp/pact-hf-a/data/pair/validation.jsonl
```

The diff should be empty and the line count should be exactly `600`. Review
`export-manifest.json` and the generated dataset card before any separately
authorized publication step. `--force` will replace only a directory carrying
a valid marker from this exporter.

## Publish and pin

Publishing is an external release action and is intentionally outside the
exporter. When a maintainer has explicit authorization to publish:

1. Export from the exact reviewed PACT-Bench source revision.
2. Verify deterministic output, row counts, source hashes, the dataset card,
   and the absence of private files.
3. Commit the staging tree to `ORG/PACT-Bench` without modifying generated
   files by hand.
4. Record the resulting immutable Hugging Face commit SHA in the release notes.
5. Pin that SHA in every experiment and citation.

Example consumer code:

```python
from datasets import load_dataset

validation = load_dataset(
    "ORG/PACT-Bench",
    "pair",
    split="validation",
    revision="FULL_40_CHARACTER_COMMIT_SHA",
)
```

Do not use a mutable branch such as `main` as the provenance identifier for a
reported experiment. The PACT dataset semantic version identifies the data
contract; the Hugging Face commit SHA identifies the exact hosted bytes. Record
both.
