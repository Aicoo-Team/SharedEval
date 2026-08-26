# Scripts

This directory contains one supported utility: the deterministic PACT-Pair
exporter under `huggingface/`.

Validate the canonical 600-row export without keeping a staging directory:

```bash
npm run export:huggingface:pact-pair
```

To inspect the generated dataset, choose an output directory explicitly:

```bash
node scripts/huggingface/export-pact-pair.mjs --output /tmp/pact-pair
```

The exporter reads only canonical repository assets. It does not run models or
modify benchmark source data.
