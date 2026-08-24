# SharedEval File-Driven PACT-Pair Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Every task uses test-driven development and the checkboxes are the delivery ledger.

**Goal:** Make `sharedeval` default to a file-driven PACT-Pair multi-heartbeat workflow, provide a genuinely isolated file-driven `single` workflow, and retain the old runners only behind explicit `--legacy` selection.

**Architecture:** Add a parallel `sharedeval-run/v1` command and artifact lane beside the existing `pact-run/v1` lane. A versioned four-file registry materializes run-scoped actor workspaces; every heartbeat creates a fresh harness that learns state only through authorized file reads; `MEMORY.md` is the sole compare-and-swap continuity channel. The new scheduler reuses PACT-Pair task loading and evaluation, but not the legacy prompt builder or transcript lifecycle.

**Tech Stack:** TypeScript 5.8, Node.js 20, Zod, YAML, `node:test` through `tsx`, existing PACT-Pair evaluator and SharedOS adapter contracts.

**Spec:** `docs/superpowers/specs/2026-08-25-file-driven-default-workflow-design.md`

## Global constraints

- Preserve existing `pact-run/v1`, prompt bytes, result schemas, and golden behavior for `single --legacy`.
- The new workspace contains exactly `AGENT.md`, `HEARTBEAT.md`, `POLICY.md`, and `MEMORY.md`; never fall back to `COO.md` or `USER.md`.
- `POLICY.md` is model-visible behavior text, not an authorization grant.
- Evaluator gold, relationship labels, and rubric content stay outside agent-readable files and public artifacts.
- Each heartbeat and each contact creates a fresh model harness. No assistant/tool transcript crosses that boundary.
- Only a validated, version-checked complete replacement of `MEMORY.md` can persist state.
- Harbor, PACT-Net, and any adapter without demonstrated lifecycle parity fail before run-directory creation or model spend.
- Do not switch the no-flag default until the local PACT-Pair file executor, artifacts, and cardinality tests are all green.

---

## Task 1: Define the workflow contract and command matrix

**Files:**

- Create: `src/runner/v1/workflow.ts`
- Create: `src/runner/v1/sharedeval-config.ts`
- Create: `src/runner/v1/sharedeval-cli.ts`
- Modify: `src/runner/v1/index.ts`
- Modify: `package.json`
- Test: `tests/runner-v1/sharedeval-config.test.ts`
- Test: `tests/runner-v1/sharedeval-cli.test.ts`

- [ ] Write failing tests for the exact matrix:

```ts
assert.equal(resolveWorkflow([]).id, 'files-multi');
assert.equal(resolveWorkflow(['multi']).id, 'files-multi');
assert.equal(resolveWorkflow(['single']).id, 'files-single');
assert.equal(resolveWorkflow(['multi', '--legacy']).id, 'legacy-multi-transcript');
assert.equal(resolveWorkflow(['single', '--legacy']).id, 'legacy-single-prompt');
```

- [ ] Add failures for `pact-run/v1` without `--legacy`, contradictory CLI/config task selection, unknown flags, invalid tick counts, and any implicit legacy fallback.
- [ ] Run RED:

```bash
npx tsx --test tests/runner-v1/sharedeval-config.test.ts tests/runner-v1/sharedeval-cli.test.ts
```

- [ ] Implement the JSON-safe contract:

```ts
export type SharedevalWorkflowIdV1 =
  | 'files-multi'
  | 'files-single'
  | 'legacy-multi-transcript'
  | 'legacy-single-prompt';

export type SharedevalWorkflowV1 = {
  mode: 'multi' | 'single';
  protocol: 'files' | 'legacy-prompt' | 'legacy-transcript';
  maxTicks: number;
  stopWhen: 'all-terminal';
};
```

- [ ] Parse strict `sharedeval-run/v1` YAML with existing complexity/path safeguards, compute a digest after effective CLI overrides, and expose parsing separately from execution so `--check` performs no model call.
- [ ] Add `sharedeval: "tsx src/runner/v1/sharedeval-cli.ts"`. Keep `benchmark` as an explicitly deprecated legacy wrapper until migration completes; do not repoint it silently in this task.
- [ ] Run GREEN and compatibility checks:

```bash
npx tsx --test tests/runner-v1/sharedeval-config.test.ts tests/runner-v1/sharedeval-cli.test.ts tests/runner-v1/config.test.ts
npm run type-check
git diff --check
```

- [ ] Commit: `feat(runner): define sharedeval workflow commands`

---

## Task 2: Build the exact four-file asset registry

**Files:**

- Create: `src/runner/v1/workspace-registry.ts`
- Modify: `src/runner/v1/agent-workspace.ts`
- Create: `dataset/shared-eval/workspaces/v1/registry.json`
- Create: `dataset/shared-eval/workspaces/v1/agents/<agent>/base/{AGENT,HEARTBEAT,POLICY,MEMORY}.md`
- Create: `dataset/shared-eval/workspaces/v1/policies/.../POLICY.md`
- Create: `dataset/shared-eval/workspaces/v1/memory-seeds/.../MEMORY.md`
- Create: `dataset/shared-eval/workspaces/v1/heartbeats/.../HEARTBEAT.md`
- Test: `tests/runner-v1/workspace-registry.test.ts`

- [ ] Write failing tests that require exactly four slots, stable lexical entry order, unique `id@version`, SHA-256 and byte-count equality, safe relative paths, valid actor roles, and explicit status.
- [ ] Add negative tests proving that `COO.md`, `USER.md`, symlinks, FIFOs, oversized files, invalid UTF-8, path traversal, missing files, draft M6-M8 execution, and incomplete PACT-Net profiles are rejected.
- [ ] Add a fixture asserting two policy IDs with the same legacy basename remain distinct semantic registry entries.
- [ ] Run RED:

```bash
npx tsx --test tests/runner-v1/agent-workspace.test.ts tests/runner-v1/workspace-registry.test.ts
```

- [ ] Implement strict Zod schemas and resolution APIs. Registry v1 uses hashes for integrity but introduces no signing/PKI requirement:

```ts
export type WorkspaceRegistryAssetV1 = {
  id: string;
  version: string;
  actorRoles: Array<'requester' | 'responder'>;
  sourcePath: string;
  byteLength: number;
  sha256: string;
  aliases: string[];
  status: 'active' | 'legacy' | 'draft' | 'incomplete';
  compatibleDatasets: string[];
  compatibleWorkflowIds: SharedevalWorkflowIdV1[];
};
```

- [ ] Make the PACT copy canonical. Record Pulse duplicates as aliases/provenance only. Create real `AGENT.md` content from the approved role semantics rather than renaming or substituting `COO.md`.
- [ ] Preserve raw UTF-8 bytes as base64 plus decoded text, byte length, and digest when resolving an asset. Do not change the existing strict return shape of `loadAgentWorkspaceV1`.
- [ ] Run GREEN and validate every registry entry:

```bash
npx tsx --test tests/runner-v1/agent-workspace.test.ts tests/runner-v1/workspace-registry.test.ts
npm run type-check
npm run validate
git diff --check
```

- [ ] Commit: `feat(runtime): register file-driven workspaces`

---

## Task 3: Materialize run-scoped workspaces and MEMORY compare-and-swap

**Files:**

- Create: `src/runner/v1/file-memory.ts`
- Create: `src/runner/v1/file-workspace.ts`
- Test: `tests/runner-v1/file-memory.test.ts`
- Test: `tests/runner-v1/file-workspace.test.ts`

- [ ] Write failing parser tests for the canonical row form `TASK-ID [pending] — note`, preserving the exact selected task-ID set, uniqueness, input order, allowed statuses, and bounded note length.
- [ ] Write failing workspace tests proving AGENT/HEARTBEAT/POLICY are read-only, MEMORY is the only writable path, stale versions return conflict without mutation, invalid full replacements do not partially write, and separate runs/actors never share bytes or versions.
- [ ] Run RED:

```bash
npx tsx --test tests/runner-v1/file-memory.test.ts tests/runner-v1/file-workspace.test.ts
```

- [ ] Implement these ports without exposing host paths:

```ts
export interface FileWorkspacePortV1 {
  read(input: { actorId: string; path: AgentWorkspaceFilePathV1 }): Promise<{
    content: string;
    receipt: FileReadReceiptV1;
  }>;
  replaceMemory(input: {
    actorId: string;
    expectedVersion: number;
    content: string;
  }): Promise<ReplaceMemoryResultV1>;
  snapshot(actorId: string): Promise<FileWorkspaceSnapshotV1>;
}
```

- [ ] Materialize into a staging directory, re-read and hash exact bytes, then atomically rename to the run-scoped destination. Capture immutable initial and final hash sets independently of private-byte retention.
- [ ] Implement MEMORY replacement as validate-then-stage-then-version-check-then-atomic-rename; the returned version and digest describe the committed bytes.
- [ ] Run GREEN:

```bash
npx tsx --test tests/runner-v1/file-memory.test.ts tests/runner-v1/file-workspace.test.ts tests/runner-v1/agent-workspace.test.ts
npm run type-check
git diff --check
```

- [ ] Commit: `feat(runtime): add run-scoped file workspaces`

---

## Task 4: Add a fresh-turn file harness without changing legacy prompts

**Files:**

- Create: `src/runner/v1/file-harness.ts`
- Create: `src/runner/v1/file-model-adapter.ts`
- Optionally create after golden locking: `src/runner/v1/openai-compatible-client.ts`
- Modify only for transport extraction: `src/runner/v1/model-adapter.ts`
- Test: `tests/runner-v1/file-harness.test.ts`
- Test: `tests/runner-v1/file-model-adapter.test.ts`
- Test: `tests/runner-v1/model-adapter.test.ts`

- [ ] First add/strengthen a legacy golden test that freezes the provider request produced by `model-adapter.ts` for an existing task.
- [ ] Write failing tests asserting that the first message of every new file harness is exactly `Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.`, contains no task/policy/memory/gold text, and exposes only authorized file/contact tools.
- [ ] Add a two-heartbeat test where heartbeat 2 receives a fresh provider message list containing no heartbeat-1 assistant/tool messages; only the committed MEMORY bytes can reveal previous progress.
- [ ] Run RED:

```bash
npx tsx --test tests/runner-v1/file-harness.test.ts tests/runner-v1/file-model-adapter.test.ts tests/runner-v1/model-adapter.test.ts
```

- [ ] Implement:

```ts
export const FILE_TURN_BOOTSTRAP_V1 =
  'Read AGENT.md and HEARTBEAT.md, then follow the heartbeat.';

export interface FreshFileHarnessV1 {
  step(input: FileTurnInputV1): Promise<FileTurnDecisionV1>;
  finalize(): Promise<void>;
}
```

- [ ] If extracting HTTP transport helpers, keep endpoint/auth/retry/telemetry/redaction only. Do not reuse `buildPactSystemPromptV1`, `buildPactTaskMessageV1`, or a legacy message array.
- [ ] Require fresh factory creation for each requester heartbeat and responder contact. Finalization must run on success, denial, timeout, parse failure, and cancellation.
- [ ] Run GREEN and full legacy adapter regression:

```bash
npx tsx --test tests/runner-v1/file-harness.test.ts tests/runner-v1/file-model-adapter.test.ts tests/runner-v1/model-adapter.test.ts tests/suites/pact-pair/prompt.test.ts
npm run type-check
git diff --check
```

- [ ] Commit: `feat(runtime): add fresh file-driven turns`

---

## Task 5: Implement the authorized contact boundary

**Files:**

- Create: `src/runner/v1/contact-agent.ts`
- Test: `tests/runner-v1/contact-agent.test.ts`

- [ ] Write failing tests for recipient workspace isolation, no authority gained from message text, no transcript continuity across repeated contacts, explicit deadline/contact/depth/tool budgets, trace correlation, and responder cleanup.
- [ ] Implement the public port exactly:

```ts
export interface ContactAgentPortV1 {
  contact(input: {
    senderId: string;
    recipientId: string;
    message: string;
    intent: string;
    purpose: string;
    traceId: string;
    deadlineMs: number;
  }): Promise<{
    status: 'completed' | 'denied' | 'failed' | 'cancelled';
    response?: string;
    errorCode?: string;
    recipientTraceId: string;
  }>;
}
```

- [ ] The in-process reference implementation authorizes recipient and purpose before factory creation, maps the outer task correlation into host state rather than recipient authority, and defaults to no recursive contact.
- [ ] Run:

```bash
npx tsx --test tests/runner-v1/contact-agent.test.ts
npm run type-check
git diff --check
```

- [ ] Commit: `feat(runtime): add authorized agent contact port`

---

## Task 6: Build one shared PACT-Pair file session, then multi and single wrappers

**Files:**

- Create: `src/suites/pact-pair/file-workflow.ts`
- Create: `src/suites/pact-pair/files-multi.ts`
- Create: `src/suites/pact-pair/files-single.ts`
- Create: `src/runner/v1/sharedeval-runner.ts`
- Test: `tests/suites/pact-pair/files-multi.test.ts`
- Test: `tests/suites/pact-pair/files-single.test.ts`

- [ ] Write `runOneFileDrivenPairSessionV1` tests before wrappers: bootstrap-only start, file-read evidence, one correlated contact per attempted task, action-specific before/after responder snapshots, validated MEMORY commit, and immediate all-terminal stop.
- [ ] Add multi tests for two ordered tasks across fresh heartbeats; tick 2 may observe tick 1 only through MEMORY. Exhaustion must emit exactly one terminal outcome per selected task, including pending tasks as `no_response`.
- [ ] Add single tests proving each selected task owns an independent requester/responder workspace, memory version, harness instance, and tick budget; `single` is not an alias of legacy.
- [ ] Run RED:

```bash
npx tsx --test tests/suites/pact-pair/files-multi.test.ts tests/suites/pact-pair/files-single.test.ts
```

- [ ] Reuse `loadPactPairTasksV1`, registered evaluation, public projection, and metric aggregation. Do not reuse the legacy task prompt or persistent adapter session.
- [ ] Make requester `POLICY.md` contain only the ordered public task queue and responder `POLICY.md` contain the selected behavioral policy. Capture the exact rendered initial bytes before the first call.
- [ ] Evaluate the latest correlated contact for each terminal task from that contact's own responder before/after snapshots. Later mutations must not change earlier action evidence.
- [ ] Run GREEN:

```bash
npx tsx --test tests/suites/pact-pair/files-multi.test.ts tests/suites/pact-pair/files-single.test.ts tests/suites/pact-pair/evaluator.test.ts
npm run type-check
git diff --check
```

- [ ] Commit: `feat(pact-pair): run file-driven sessions`

---

## Task 7: Add a separate durable artifact lane and cardinality gate

**Files:**

- Create: `src/runner/v1/file-workflow-artifacts.ts`
- Create: `src/runner/v1/file-workflow-ledger.ts`
- Test: `tests/runner-v1/file-workflow-artifacts.test.ts`
- Test: `tests/runner-v1/file-workflow-ledger.test.ts`
- Modify: `src/suites/pact-pair/files-multi.ts`
- Modify: `src/suites/pact-pair/files-single.ts`

- [ ] Write failing tests for duplicate task IDs, interrupted heartbeat commits, no-response rows, public/private redaction, retention-off behavior, initial/final hashes, and final selected/result/evaluation cardinality equality.
- [ ] Keep legacy `pactTaskResultV1Schema` unchanged. Define new strict schemas with workflow ID, terminal tick/status, public evaluation, and private full evaluation/metrics.
- [ ] Commit each completed heartbeat as one logical ledger record containing reads, contacts, MEMORY CAS, and private snapshots. Publish task result/evaluation exactly once using task-ID duplicate guards.
- [ ] Scan public `run.json`, `events.jsonl`, `results.jsonl`, `summary.json`, and `checkpoint.json` for sentinel MEMORY/contact/gold/credential bytes in tests.
- [ ] Run:

```bash
npx tsx --test tests/runner-v1/file-workflow-artifacts.test.ts tests/runner-v1/file-workflow-ledger.test.ts tests/suites/pact-pair/files-multi.test.ts tests/suites/pact-pair/files-single.test.ts
npm test
npm run type-check
git diff --check
```

- [ ] Commit: `feat(runner): persist file workflow evidence`

---

## Task 8: Wire dispatch, fail-closed gates, and the new default

**Files:**

- Modify: `src/runner/v1/sharedeval-cli.ts`
- Modify: `src/runner/v1/sharedeval-runner.ts`
- Modify: `src/runner/v1/runner.ts` only for an explicit legacy entry point if required
- Create: `src/runner/v1/file-workflow-gates.ts`
- Modify: `src/runner/v1/index.ts`
- Modify: `package.json`
- Modify: `docs/running.md`
- Create: `docs/file-driven-workflows.md`
- Test: `tests/runner-v1/sharedeval-dispatch.test.ts`
- Test: `tests/runner-v1/file-workflow-gates.test.ts`

- [ ] Write failing dispatch tests for no-flag → files-multi, explicit new single, exact legacy single, unavailable legacy multi with an actionable successor message, and pre-spend failures for Harbor, PACT-Net, or unsupported SharedOS parity.
- [ ] Implement `single --legacy` by calling the existing runner without changing its result/scoring semantics. Keep `multi --legacy` unavailable until the reviewed #35 legacy successor lands; never redirect it to the new scheduler.
- [ ] Change only the `sharedeval` wrapper's no-flag behavior to files-multi after Tasks 1-7 are green. Keep compatibility wrappers documented and explicit.
- [ ] Document the four commands, asset/version selection, initial/final workspace provenance, privacy boundary, and why new and legacy metrics cannot be pooled.
- [ ] Run:

```bash
npx tsx --test tests/runner-v1/sharedeval-dispatch.test.ts tests/runner-v1/file-workflow-gates.test.ts tests/runner-v1/sharedeval-cli.test.ts tests/runner-v1/legacy-dispatch.test.ts
npm run type-check
npm run validate
npm test
git diff --check
```

- [ ] Commit: `feat(runner): default to file-driven sharedeval`

---

## Task 9: Review the complete branch and prepare merge evidence

**Files:** all files changed by Tasks 1-8.

- [ ] Run a requirements audit against every normative statement in the design spec and record each statement's implementation/test anchor in the PR description.
- [ ] Run a security review focused on gold isolation, message-as-authority, file path handling, CAS, fresh-turn boundaries, public/private projection, and pre-spend fail gates.
- [ ] Run full verification from a clean checkout:

```bash
npm ci
npm run type-check
npm run validate
npm test
npm run test:sharedos
git diff --check
```

- [ ] Run two scripted end-to-end fixtures: one two-task `files-multi` run and two independent `files-single` sessions. Assert workflow IDs, stop reasons, selected/result/evaluation cardinality, initial/final digests, fresh harness counts, and zero sentinel leakage.
- [ ] Request two-stage review: spec compliance first, then code quality/security. Resolve every Critical or Important finding and rerun affected plus full verification.
- [ ] Rebase onto the actual current `main` merge ancestry once network fetch is available, push a `codex/` branch, open a reviewable PR, and merge only after required checks and approval are green.

