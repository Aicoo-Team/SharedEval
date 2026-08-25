# PR 31 DS-grid historical evidence

This directory preserves a bounded, sanitized record of the evidence proposed in
PACT pull request 31. It is **historical evidence**, not an independent
reproduction. Every inherited record is labeled:

- `protocol: legacy-single-prompt`
- `status: historical`
- `completeness: incomplete`

The source PR reported SharedOS revision `846cbf6`. That abbreviated identity is
preserved exactly as reported and is not independently verified. It is historical
provenance only; the launcher does not select or modify a SharedOS revision.

## Inventory

The source PR changed 106 files. This successor accounts for all of them without
copying private or non-portable artifacts:

- 49 of 50 source configurations are represented in the manifest;
- 32 configurations satisfy the reviewed current PACT schema and can be expanded
  deterministically, including all five relationship configurations;
- 17 D2R/D6 configurations are historical-only because their policy identifiers
  are intentionally unsupported by the current runner schema;
- `smoke_R1.yaml` is excluded; the pinned smoke configuration remains;
- 16 aggregate-only rows are preserved from `rescore_v2_3arms.json`;
- 56 other source files are explicitly classified in the manifest exclusions.

The five zero-byte relationship stdout files are excluded. All judge samples,
verdicts, and agreement output are excluded because both verdict sets contain only
HTTP 403 failures and the reported comparison count is zero. Narrative reports,
raw stdout, personal launchers, and unrelated modifications are also excluded.
No task questions, model responses, gold facts, labels, traces, or private run rows
are included.

The aggregate is incomplete: the source PR did not include the raw run directories
or traces needed to reproduce it, and narrative reports disagree with the selected
aggregate source. The narrative reports are therefore not canonical evidence.

## Validate

From the repository root:

```sh
npx tsx rebuttal/evidence/pr31-ds-grid/validate.ts --json
```

Validation checks the manifest and aggregate schemas, source checksums, exact
inventory accounting, deterministic task selections, and current-main runner/task
contracts. Unsupported D2R/D6 entries must remain historical-only.

## Inspect or launch an executable configuration

List the 32 executable configuration identifiers:

```sh
npx tsx rebuttal/evidence/pr31-ds-grid/launch.ts --list
```

Check one expanded configuration without contacting a provider:

```sh
npx tsx rebuttal/evidence/pr31-ds-grid/launch.ts --mode check --config smoke_R1_pinned
```

Run one configuration only after explicitly opting in:

```sh
PACT_MODEL_API_KEY=... npx tsx rebuttal/evidence/pr31-ds-grid/launch.ts --mode run --config smoke_R1_pinned
```

There is no default configuration. Repository and SharedOS locations may be given
explicitly with `--repo-root` and `--sharedos-dir`; otherwise portable
module-relative defaults are used. Output stays under `runs/pr31-ds-grid/`, and
trace persistence is disabled.
