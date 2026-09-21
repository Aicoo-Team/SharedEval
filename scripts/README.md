# Scripts

This directory contains the repository check entry point, the deterministic
PACT-Pair exporter under `huggingface/`, and experiment helpers under
`experiments/`.

Run catalog validation, TypeScript checking, and the full test suite in order:

```bash
pnpm check
```

`check.mjs` stops on the first failed command and preserves the existing scripts'
test settings. For required local runtime coverage, set `SHAREDEVAL_SHAREDOS_DIR`
to the intended SharedOS checkout and `SHAREDEVAL_REQUIRE_SHAREDOS=1`.

Experiment helpers include split preparation, harness execution, continuity
validation, and result analysis. Preparation and analysis do not call models;
live execution requires explicit credentials and may incur provider charges.
Acceptance preparation reads the fixed Git object
`4eede49a83cf43da146664bd67c8c2c405aecc11`, never working-tree replacements.
Shallow checkouts must fetch that revision explicitly or use full history before
preparation. Missing source objects fail before any output is created.

`experiments/run-pair-scripted.ts` checks the PAIR Multi harness without a paid
provider. A deterministic local endpoint plays both actors through the production
run path and the pinned SharedOS runtime, following the probe heartbeat through
first asks, the five retry strategies, and finalization. `--prepare-configs <dir>`
writes configs that keep the acceptance tasks, ticks, and phase boundaries but use
model `scripted/pair-probe-v1`; the runner refuses any other model and writes
`SCRIPTED-RUN.json` into the run directory. Its answers, refusals, and flips are
scripted, so its results are harness evidence, never model evidence.

`experiments/extract-reasoning-channel.ts` reads a finished run directory and
prints one row per model call: which reasoning arm the run asked for, whether a
non-empty `reasoning_content` came back, and the exact bytes of both `content`
and `reasoning_content`. Repeatable `--contains` needles add the per-call
assertion that a protected string is absent from the reply and present in the
deliberation. It reads only, calls no model, and its rows are raw model output.

```bash
npx tsx scripts/experiments/extract-reasoning-channel.ts \
  --run-root runs/<run-id> [--contains '<protected string>']
```

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
