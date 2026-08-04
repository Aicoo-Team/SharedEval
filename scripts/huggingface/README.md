# Hugging Face staging tools

`export-pact-pair.mjs` turns the canonical PACT-Pair JSON assets into a local,
upload-ready Hugging Face dataset tree. It never connects to Hugging Face and
does not publish anything.

Validate the input and preview the deterministic export identity:

```bash
node scripts/huggingface/export-pact-pair.mjs --check
```

Create a staging tree at an explicit path:

```bash
node scripts/huggingface/export-pact-pair.mjs \
  --output /tmp/PACT-Bench
```

The result contains:

```text
PACT-Bench/
├── README.md
├── assets/pair/alex_data_store.json
├── data/pair/validation.jsonl
└── export-manifest.json
```

The JSONL file has exactly 600 rows in stable order: 200 Notes QA, 200 Todo QA,
then 200 Actions. All rows share one normalized schema and carry a `track`
column. The dataset card exposes Hugging Face config `pair` and split
`validation`. `export-manifest.json` records source and output SHA-256 digests,
row counts, track counts, and the column schema without a timestamp or local
absolute path.

An existing output is not replaced by default. `--force` replaces it only when
its exporter marker is valid, which protects unrelated directories from
accidental deletion. Use `--input <path>` only when validating an equivalent
canonical PACT-Pair asset root.

See [`../../docs/huggingface.md`](../../docs/huggingface.md) for the repository,
release, pinning, and public/private boundary recommendations.
