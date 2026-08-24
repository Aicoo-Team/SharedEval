# SharedEval Open PR Consolidation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Treat every GitHub mutation as an auditable delivery step: verify exact head SHA and checks immediately before approval, rebase, merge, comment, or close.

**Goal:** Land every still-valid open contribution in dependency order, repair blocked work through repository-owned successors, and close superseded or mixed-lifecycle PRs with links to their replacements.

**Architecture:** Data/evaluator changes, Harbor reliability, legacy reproducibility, and the new file-driven lifecycle are separate lanes. Merge only commits whose semantics fit one lane. A PR that mixes legacy prompt/transcript execution with the new default is split; the safe successor is merged and the original is closed as superseded.

**Tech Stack:** GitHub pull requests/checks/reviews, Git, TypeScript/Node test suite, PACT-Pair validation and SharedOS conformance.

**Spec:** `docs/superpowers/specs/2026-08-25-file-driven-default-workflow-design.md`

## Global merge protocol

- [ ] Refresh `main`, open PR list, head/base SHA, mergeability, draft state, review decision, and every required check immediately before each mutation.
- [ ] Use isolated worktrees or disposable clones; never modify `/Users/wangxiang/Desktop/my_workspace/PACT`.
- [ ] Rebase successors onto current `main`, push only with `--force-with-lease` when history replacement is necessary, and preserve contributor branches when `maintainerCanModify=false`.
- [ ] Run targeted tests, `npm run type-check`, `npm run validate`, `npm test`, and relevant SharedOS/Harbor checks on the exact candidate tree.
- [ ] Do not approve or merge a PR with `CHANGES_REQUESTED`, failed/pending checks, unresolved review threads, conflicts, or a known correctness blocker.
- [ ] Before closing an original PR, first create or merge the stated successor, add a comment with the successor and merge commit, and explain which behavior was intentionally not copied.
- [ ] Label old prompt-preload/transcript artifacts and workflow IDs as legacy. Never mix their metrics with `files-multi` or `files-single`.

---

## Task 1: Merge #29 as the dataset and relationship-policy baseline

**PR:** `#29 feat/pact-pair-dataset-v2-release`

**Files to review:**

- `dataset/pact-pair/manifest.yaml`
- `dataset/pact-pair/relationship_labels/relationship_label_matrix_v2.json`
- `dataset/pact-pair/policies/D2R_PRINCIPLES.md`
- `dataset/pact-pair/policies/D6_PRINCIPLES_TIGHT.md`
- `src/suites/pact-pair/relationship-labels.ts`
- `src/suites/pact-pair/schemas.ts`
- `src/validate.ts`
- `scripts/huggingface/export-pact-pair.mjs`

- [ ] Rebase the exact #29 head onto current main without importing runner lifecycle changes.
- [ ] Verify all 600 tasks resolve one valid relationship label and policy profile, matrix/manifest hashes match, exports are deterministic, and unknown/duplicate relationships fail closed.
- [ ] Add a PR note that D2R/D6 are benchmark policy profiles, not host-injected persona authority and not an implementation of the new workspace lifecycle.
- [ ] Run:

```bash
npm run validate
npm run export:huggingface:pact-pair
npm run type-check
npm test
git diff --check
```

- [ ] Request fresh approval, merge after checks pass, and record the merge SHA for Tasks 5-6.

---

## Task 2: Repair and merge #13's Harbor checkpoint lane

**PR:** `#13 feat/harbor-streaming-results`

**Known blocker:** A host callback can append `results.jsonl`, fail before evaluation/trace/checkpoint, then be retried. One selected task becomes duplicate result rows and summary count while evaluation has one row.

**Files:**

- Modify: `src/suites/pact-pair/runner.ts`
- Modify: `src/suites/pact-pair/resume.ts`
- Modify: `src/runner/v1/artifacts.ts`
- Modify: `src/runner/v1/cli.ts`
- Modify: `src/runner/v1/backends/harbor-backend.ts`
- Test: `tests/suites/pact-pair/resume.test.ts`
- Test: `tests/runner-v1/harbor-backend.test.ts`
- Add a runner partial-write fault-injection test.

- [ ] Create a repository-owned corrective branch if the contributor branch cannot be safely edited.
- [ ] First reproduce the failure with one selected task and an injected failure between result and evaluation publication; assert the old tree returns two result rows, one evaluation row, and exit 0.
- [ ] Implement task-ID-aware prepare/commit/recovery so result, evaluation, trace, checkpoint, in-memory task run, and summary are published once. A retry either completes the prepared task or observes it already committed; it never re-executes a committed model action.
- [ ] Replace broad `infrastructure_error` retry with a strict taxonomy. Model no-decision, invalid tool arguments, and protocol errors are non-retryable; transient host/storage/provider failures are retryable only when no committed action would be duplicated.
- [ ] Add a run-directory single-writer lock and unique staging paths. A second fresh/resume writer must fail before spend or artifact mutation.
- [ ] Run:

```bash
npx tsx --test tests/suites/pact-pair/resume.test.ts tests/runner-v1/harbor-backend.test.ts
npm run type-check
npm run validate
npm test
git diff --check
```

- [ ] Reply to the existing blocker review with exact commits and fault-injection evidence, request re-review, then merge only after approval and all checks pass.
- [ ] If corrective work lives in a successor, merge it and close #13 with the successor/merge link; otherwise merge #13 itself.

---

## Task 3: Retarget and merge #14 after #13

**PR:** `#14 watch_runs`

- [ ] After Task 2 merges, retarget #14 from the #13 feature branch to main and rebase on the exact #13 merge SHA.
- [ ] Update `scripts/watch_runs.ts` to consume the formal failure/status taxonomy rather than guessing model/other status from error strings.
- [ ] Add fixtures for incomplete JSONL tails, historical legacy artifacts, new committed artifacts, non-retryable model/protocol failures, and retryable infrastructure failures.
- [ ] Mark ready only after the dependency and tests are real.
- [ ] Run:

```bash
npx tsx --test tests/scripts/watch-runs.test.ts
npm run type-check
npm run validate
npm test
git diff --check
```

- [ ] Request approval and merge when clean and green.

---

## Task 4: Replace #20 with an explicit legacy multi-attempt successor

**PR:** `#20 multi-attempt requester`

- [ ] Create a repository-owned successor from current main; copy only multi-attempt behavior that remains reproducible and independent of the new file-driven scheduler.
- [ ] Give it workflow ID `legacy-multi-transcript` or a narrower documented legacy ID and require `sharedeval multi --legacy`. No no-flag/config-only route may reach it.
- [ ] Record `executionMode: legacy-prompt` or `legacy-transcript`, prompt/config hashes, resolved model identity, retry taxonomy, and exact source SHA in run provenance.
- [ ] Add tests proving no `--legacy` rejects the old configuration and that model/protocol errors do not trigger best-of-N retries.
- [ ] Run targeted tests plus full type/validate/test checks.
- [ ] Merge the successor after review, comment on #20 with its PR and merge SHA, then close #20 without merging the dirty original.

---

## Task 5: Extract evaluator value from #21 and close it

**PR:** `#21 requester relationship grid`

- [ ] Diff #21 against merged #29 and the safe-core successor in Task 6. Inventory unique relationship-grid, fail-loud, requester-invariant grant, task-loader, and evaluator tests.
- [ ] Port only dataset/schema/evaluator tests or fixes whose behavior is independent of the old `sharedos-embedded` prompt/turn lifecycle.
- [ ] Verify fixed denominator, zero-denominator, relationship routing, and malformed-label tests.
- [ ] Merge the safe extraction through Task 6 or a tiny dedicated successor.
- [ ] Comment that #29 plus the safe-core successor preserve the valid work while the old execution lifecycle is intentionally excluded; close #21.

---

## Task 6: Split #30 and merge only its evaluator/hardening core

**PR:** `#30 runner-v2 relationship matrix and trajectory work`

**Safe-core candidates:**

- `src/suites/pact-pair/evaluation.ts`
- `src/suites/pact-pair/evaluator.ts`
- `src/suites/pact-pair/index.ts`
- `src/suites/pact-pair/task-loader.ts`
- `scripts/rescore-ds-grid-v2.ts`
- evaluator/matcher/provider-retry/local-breaker/causal-trace/side-effect-retention tests that do not depend on prompt lifecycle.

- [ ] Wait for #29, then create a clean safe-core successor on current main.
- [ ] Exclude trajectory defaults, prompt preload, persistent requester transcript, runner selection, and SharedOS embedded lifecycle scaffolding.
- [ ] Add the unique tests inventoried from #21.
- [ ] Remove machine-specific absolute paths from rescore scripts; require an explicit argument or repository-relative fixture.
- [ ] Verify side-effect-before-failure contributes consistently to live summary and offline rescore, not merely to the latter.
- [ ] Run fixed-metric fixtures, full type/validate/test, and a public-artifact privacy scan.
- [ ] Merge the safe-core successor, comment on #30 with what moved and what is deferred to the v1 lifecycle, then close #30.

---

## Task 7: Archive #31 as legacy evidence, then merge

**PR:** `#31 DS-grid real artifacts`

- [ ] Wait for #29 and the Task 6 safe evaluator core.
- [ ] Rebase artifacts and reproducible rescore metadata onto current main.
- [ ] Move/label output under a clear legacy-prompt namespace and include `executionMode`, exact runner/dataset/label commit, config hash, model route, repair history, and the statement that these results cannot be pooled with agent-workspace/v1.
- [ ] Scan for provider credentials, local absolute paths, private contact/memory bytes, and personal annotation assets.
- [ ] Re-run the schema-v2 rescore and confirm deterministic output.
- [ ] Rename the PR as an archival chore, request approval, and merge only after validation and provenance checks pass.

---

## Task 8: Close #27 as historical scaffolding

**PR:** `#27 multi-exchange protocol`

- [ ] Confirm its commits remain ancestors/reference material for #35 and that no unique safe fix is absent from successors.
- [ ] Comment that `requester_message` and `exchanges[]` remain design references, but the PR's persistent session semantics conflict with fresh-heartbeat v1.
- [ ] Close #27 without rebase or merge.

---

## Task 9: Split #35 into explicit legacy preservation and file-driven v1 work

**PR:** `#35 heartbeat trajectory`

- [ ] Mark #35 draft/WIP while successor work is active; do not merge its combined prompt-preload and trajectory design.
- [ ] Create a legacy successor that preserves the historical Pulse/#35 run only behind `sharedeval multi --legacy`, with legacy workflow ID and provenance. Its preloaded COO/POLICY/MEMORY and transcript behavior must be named, tested, and isolated.
- [ ] Ensure the new file-driven implementation PR from `2026-08-25-file-driven-pair-default.md` owns `AGENT.md → HEARTBEAT.md → POLICY.md → MEMORY.md`, authorized reads, fresh turns, CAS, gold isolation, and new workflow IDs.
- [ ] Use #35's trajectory/evaluation ideas only after adapting them to file-read receipts and MEMORY-only continuity. Do not copy its prompt interpolation or shared transcript.
- [ ] Merge the legacy successor only if its reproducibility and privacy gates pass. Merge the v1 successor only after the full Task 9 gate in the implementation plan.
- [ ] Comment on #35 with both successor links, classify historical pilot outputs as legacy-prompt, and close #35.

---

## Task 10: Final repository convergence audit

- [ ] Query every PR and verify there are no remaining open branches whose work is neither merged, explicitly blocked with current evidence, nor superseded with a linked successor.
- [ ] Expected exceptions are temporary and named: a PR may remain open only while awaiting an external review/check or while its already-linked corrective successor is actively being completed.
- [ ] Run the complete current-main gate:

```bash
npm ci
npm run type-check
npm run validate
npm test
npm run test:sharedos
git diff --check
```

- [ ] Publish a final table with original PR, disposition, successor, exact merge/close SHA, workflow classification, tests, and any remaining non-merge blocker.
- [ ] Confirm no legacy result is relabeled as file-driven and no new default silently falls back to a legacy runner.

