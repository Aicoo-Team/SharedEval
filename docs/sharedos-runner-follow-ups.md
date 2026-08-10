# SharedOS runner follow-ups

Status: active after PR [#9](https://github.com/xisen-w/PACT/pull/9)

Last updated: 2026-08-08

PR #9 establishes the alpha integration: PACT can execute a trial as one
bounded turn through the real SharedOS kernel, locally or in a Harbor
container. Until the SharedOS packages are released, the supported integration
loads a pinned, locally built SharedOS source checkout through
`PACT_SHAREDOS_DIR`.

This is an intentional interim state. It is not yet a fresh-clone npm
integration, a production-grade container security boundary, or an official
third-party leaderboard execution path.

## Completed baseline

- [x] One PACT trial maps to one bounded SharedOS turn.
- [x] Each trial receives a fresh kernel, namespace, workspace, and grants.
- [x] PACT-Pair tool calls pass through the SharedOS invocation gate.
- [x] Denial, cancellation, failure, runtime events, and authorization audit
  events are retained with the execution-adapter identity.
- [x] Local and Harbor backends can run a real model with
  `benchmark.execution.adapter: sharedos-embedded`.
- [x] The source integration is checked against SharedOS commit
  `846cbf64830d1a77bf477b98fd3586cd5cdff02e` in trusted CI.

## P0 — harden the interim source-checkout mode

These items do not depend on an npm release and should land before source-mode
runs are treated as reproducible results.

- [ ] Reject a dirty SharedOS checkout and unexpected package versions before
  local execution or Harbor staging.
- [ ] Hash every staged SharedOS manifest and `dist` file into a canonical
  bundle digest; do not treat Git `HEAD` alone as executable provenance.
- [ ] Record the SharedOS commit, bundle digest, package list, PACT revision,
  and Harbor image ID in durable `run.json` metadata.
- [ ] Propagate `PACT_EXECUTION_ADAPTER` for scripted Harbor tasks as well as
  real-model tasks, and fail if a requested `sharedos-embedded` run falls back
  to `pact-public-runner`.
- [ ] Add a deterministic Harbor smoke that actually executes QA, action,
  denial, and unavailable-tool cases through `sharedos-embedded` in the
  container.
- [ ] Pass the permission-filtered `AgentTurnRequest.tools` surface to the
  model-facing harness. The current kernel still re-authorizes invocation, but
  the model-facing provider must not keep receiving the original unfiltered
  tool list.
- [ ] Compare requested, resolved, and provider-served model identities; mark
  model drift invalid instead of leaving `servedId` unset.
- [ ] Add host-level timeouts and termination for Docker build, image, and
  Harbor subprocesses.
- [ ] Preserve caller-supplied seed/world fixtures across local and Harbor
  backends, or explicitly reject unsupported custom seeds.
- [ ] Update Harbor documentation so it distinguishes enforced no-network
  mode from the real-model mode's coarse internet gate and application-level
  endpoint pinning.

Acceptance criteria:

- Changing any staged SharedOS byte without changing Git `HEAD` changes the
  recorded provenance or fails the run.
- Every container smoke result reports `adapterId: sharedos-embedded`; a
  silent public-runner fallback fails CI.
- Tools outside the granted surface are neither advertised to the model nor
  invokable through the kernel.
- A hung Docker or Harbor command cannot hang the PACT runner indefinitely.

## P1 — migrate after the SharedOS SDK release

The package migration starts only after the SharedOS alpha packages are
published or an equivalent distributable bundle is approved.

- [ ] Depend on exact versions of `@sharedos/sdk` and `@sharedos/testkit`.
  The runner currently uses testkit host helpers in addition to the SDK.
- [ ] Lock package integrity in `package-lock.json` and record package versions
  plus integrity in run provenance.
- [ ] Replace filesystem `dist` imports and structural contract mirrors with
  package imports where the published surface permits it.
- [ ] Build the Harbor image from the same locked packages installed by PACT
  users.
- [ ] Remove source-checkout staging from the supported evaluation path; keep
  it only as an explicit developer override if it remains useful.
- [ ] Test the supported minimum Node 20.11 and Node 22.

Acceptance criteria:

- A clean machine can clone PACT, run `npm install`, and execute a real
  `sharedos-embedded` task without a sibling SharedOS repository.
- Local and Harbor runs resolve the same locked SharedOS package bytes.
- Official artifacts no longer depend on a machine-local
  `PACT_SHAREDOS_DIR`.

## P1 — make public pull-request CI fork-safe

The current source-conformance jobs need a private checkout token. GitHub does
not expose repository secrets to fork pull requests, so those jobs cannot be
required for public submissions in their current form.

- [ ] Make all required `pull_request` checks run without repository secrets or
  private checkout credentials.
- [ ] Install the public SharedOS packages used by contributors once they are
  released.
- [ ] Keep private-source conformance in a trusted scheduled, manual, or
  post-merge workflow.
- [ ] Set `persist-credentials: false` whenever trusted CI checks out a private
  dependency.
- [ ] Do not use `pull_request_target` to execute submission code.

Acceptance criteria:

- A fork PR receives and passes the same required public checks as an internal
  PR without maintainer intervention or secret exposure.
- Trusted conformance still fails closed when its pinned dependency is missing
  or incompatible.

## P1 — separate trusted evaluation from untrusted submissions

The merged Harbor runner is suitable for an alpha run of the trusted PACT
image. It must not yet be treated as the security boundary for arbitrary
submission code: real-model tasks enable Harbor's coarse internet gate, and
the current image carries the dataset and evaluator.

- [ ] Keep model credentials behind a trusted model gateway, or enforce real
  network-level egress policy before running untrusted code with credentials.
- [ ] Move private gold, evaluation, and authoritative scoring outside the
  submission container.
- [ ] Recompute the evaluation on the trusted host from validated decisions and
  state transitions; do not trust container-reported `correct` or evaluation
  booleans.
- [ ] Retain no-network, read-only, non-root, capability, resource, and timeout
  restrictions for public smoke runs.
- [ ] Publish only aggregate, sanitized results; keep hidden tasks, gold,
  per-task evaluations, traces, and credentials private.

Acceptance criteria:

- Submission code cannot read gold or model credentials.
- A forged container evaluation cannot affect an official score.
- Public artifacts contain no private gold-derived details or secrets.

## P2 — pull-request submission and leaderboard workflow

- [ ] Accept immutable submissions under
  `submissions/<submission-id>/<version>/` with a strict `pact.yaml`, README,
  source or Dockerfile, and locked dependencies.
- [ ] Validate path/manifest identity, symlinks, submodules, file count, size,
  official Docker policy, buildability, and protocol smoke in public CI.
- [ ] Merge accepted submissions as `pending` or `community/unverified`; never
  accept contributor-supplied results as official scores.
- [ ] Let only a trusted maintainer run create or update
  `leaderboard/verified/**` entries.
- [ ] Protect workflows, evaluators, hidden-data boundaries, and verified
  leaderboard entries with CODEOWNERS and required non-author review.
- [ ] Record submission commit/tree digest, image digest, PACT revision,
  SharedOS package integrity, dataset/evaluator version, model provenance,
  budgets, task counts, and a private-run attestation digest for every verified
  result.

Acceptance criteria:

- A contributor can submit from a fork without an Aicoo, SharedOS, Harbor, or
  model API key.
- Contributors cannot directly write or overwrite verified leaderboard scores.
- Every verified entry points to immutable submission and trusted-run
  provenance.

## Exit criterion

This follow-up plan is complete when a clean third-party machine can install
PACT and released SharedOS packages, run a SharedOS-backed public evaluation,
and submit a fork PR whose required checks pass without secrets, while official
scores are produced only by a reproducible trusted evaluation boundary.
