# Architecture

SharedEval has one execution boundary: SharedOS.

## Ownership

| SharedOS owns | SharedEval owns |
| --- | --- |
| turn admission and execution | workflow and heartbeat scheduling |
| capability filtering and authorization | immutable run bindings and durable host storage |
| file, benchmark-tool, and message invocation | dataset and task selection |
| timeout, cancellation, result status, and audit events | scoring, summaries, and artifacts |

SharedEval supplies implementations of host storage and benchmark resources,
but it does not make authorization decisions. SharedOS receives grants from the
host and remains the only permission authority.

## Turn and message flow

```text
SharedEval scheduler
  -> SharedOS requester turn
       -> authorized file and benchmark tools
       -> authorized request envelope
  -> durable SharedEval message log
  -> SharedOS responder turn
       -> authorized file and benchmark tools
       -> authorized reply envelope
  -> durable reply correlation
  -> SharedEval evaluation and artifacts
```

The model supplies only a recipient, a task-bound request, and JSON-safe
payload. Actor, owner, purpose, trace, and message identifiers come from trusted
runtime context. The responder runs only from an accepted durable request; its
reply is separately authorized and correlated with `replyTo`.

## Source layout

- `src/contracts/` contains JSON-safe host and benchmark contracts.
- `src/execution/sharedos/` verifies and loads the pinned SharedOS production
  packages.
- `src/runner/` contains the pure model driver, scheduler, durable stores, and
  artifact schemas.
- `src/suites/pact-pair/` contains PACT-Pair task loading, raw data operations,
  workspace behavior, and evaluation.
- `src/suites/pact-net/` contains PACT-Net data and evaluation validation only.
- `src/evaluation/` and `src/datasets/` are dataset-neutral registries.

Dependencies point inward: suites use runner contracts, the runner uses the
SharedOS boundary, and SharedOS never imports SharedEval or benchmark code.

## Security invariants

- Authority is denied unless an exact capability grant matches.
- Tool discovery is filtered, and every invocation is authorized again.
- Messages carry no authority.
- Each actor sees only its own four workspace files.
- Only `MEMORY.md` may be replaced, using an exact version check.
- Request and reply capabilities are recipient-scoped and usage-bounded.
- Provider requests contain only tool name, description, and input schema.
- An unavailable or mismatched SharedOS build fails before model spend.

The normative decisions are recorded in
[ADR 0001](adr/0001-agent-workspace-v1.md) and
[ADR 0002](adr/0002-sharedos-first-execution-plane.md).
