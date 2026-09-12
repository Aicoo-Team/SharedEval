# Scripts

This directory contains the deterministic PACT-Pair exporter under `huggingface/`,
experiment launchers under `experiments/`, and a bounded scripted NET pilot.

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

The NET entry points are `pact-net-pilot.ts` for native three-actor execution and
`pact-net-pilot-evaluate.ts` for a separate post-hoc consistency check and score.
See the [P-01 pilot guide](../docs/pact-net-pilot.md) for pinned prerequisites,
fresh-output commands, process restart and explicit scope. They do not implement
the general `sharedeval` NET mode or call paid models.

The bounded execution entry point also accepts `--profile` for
[assigned procurement profiles](../docs/pact-net-assigned-profiles.md). Those
synthetic cases do not automatically qualify for the P-01 scoring entry point.
