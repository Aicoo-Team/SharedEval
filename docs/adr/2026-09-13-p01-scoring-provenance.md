# P-01 scoring provenance and result consistency

Status: proposed with implementation. Extends the [native NET command adapter](2026-09-13-native-net-cli.md).

## Context

The initial native CLI report binds a score to its execution evidence and current
checkpoint, but does not identify the evaluator bytes, rubric bytes or actual
Python version. Its output schema rejects malformed and non-finite fields while
allowing contradictions between checkpoint results, hard gates, completion flags
and the reported score. A substitute evaluator can expose that gap even though
the canonical P-01 evaluator returns consistent results.

## Decision

Publish new unified CLI reports as `pact-net-evaluation/v2`. Retain configuration
and evidence digests, evaluator registration, submission and evaluation, and add
required `pact-net-p01-evaluation-provenance/v1` metadata:

- SHA-256 of the evaluator Python bytes and P-01 manifest bytes used for this call.
- SHA-256 of the submitted UTF-8 JSON bytes: `JSON.stringify(submission, null, 2)`
  followed by one newline.
- The launcher version and SHA-256, plus the Python implementation and version
  obtained in the same process that evaluates the captured inputs.

Snapshot the evaluator and manifest into a private temporary tree before invoking
Python, and run those captured bytes. The evaluator reads the captured manifest
and submission. This prevents a later change to the original source files from
being mislabeled as the input of the completed evaluation. Temporary material is
removed on success or failure. Registration and committed-evidence projection
still run before any temporary file or evaluator process is created.

Validate returned results against the captured, supported P-01 manifest. Require
the declared checkpoint IDs, labels and weights and the declared hard gates,
without missing, duplicate or additional entries. A passed checkpoint or gate
must have no failure details; a failed one must explain its failure. Recompute weighted points and
total, four-decimal checkpoint ratio, safety from hard gates, completion from
safety and all checkpoint points, and the registered score formula:

```text
safe = every hard gate passes
full = safe and points == total
score = safe ? round(0.5 * points / total + 0.5 * full, 4) : 0
```

Reject inconsistent results or unsupported scoring semantics before publishing a
new report. Do not evaluate arbitrary formula text. This is result consistency
validation; the Python evaluator remains responsible for deciding whether each
checkpoint and gate passes for the submission.

Support the known P-01 checkpoint and gate identities and declared aggregation
semantics. Match labels and positive integer weights to the captured manifest;
do not claim that a matching hash independently certifies canonical predicate
bytes. Four-decimal rounding follows Python's rounding of the actual binary
floating-point value, including ties to even, rather than JavaScript's default
tie handling.

## Compatibility and ownership

The run config, native checkpoint and execution receipt formats remain unchanged.
Existing committed runs can be scored explicitly to produce a v2 report under
the existing command and native writer locks. Scoring still cannot schedule a
turn, repair a pending checkpoint or register assigned/world fixtures for P-01.
Previously saved v1 reports remain historical artifacts without the new
provenance guarantees; they are not silently relabeled. The legacy evaluation
script retains its flat result and submission filenames and shapes.

## Limits

Hashes identify captured inputs under trusted host storage. They do not sign a
report, authenticate the operator or independently prove checkpoint correctness.
The recorded Python identity is not a full environment or dependency attestation.
The canonical P-01 script uses standard-library code and the declared manifest
and submission; arbitrary substitute scripts may have other dependencies not
described by these hashes. No additional rubric, model experiment or general NET
scoring capability is registered by this change.
