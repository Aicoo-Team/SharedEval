# PAIR recovery and NET integration verification

The combined candidate passes the required-runtime full check and a separate
cross-version NET continuation check. This report concerns a materialized local
tree, not a merged PR or a combined GitHub Actions run. Documentation written
after verification, including this report, is outside the tested tree.

## Fixed inputs

| Input | Identity |
| --- | --- |
| NET65 | `5da4785c781cd660fd3c41cc42cdbe137f895f32` |
| PAIR67 | `c1bedc072ae9a020cbd4c9263ebea4d741d246d2` |
| Governance58, including main | `23a432f4cdd1e7b7233216dcdec92c1e0b4edc3f` |
| Main included by governance | `dc5d482403bd5dfb38ab6af92db399d6cbea3121` |
| Final candidate tree | `e93d46f934987f380137a684f244fff9f6e66a43` |
| Node | `24.18.0` |
| SharedOS revision | `3aa07e33999b656a10ace294fd4e41df8cbc318e` |
| SharedOS runtime digest | `4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d` |

The fresh worktree has detached HEAD at NET65 and an intentionally staged combined
tree. Neither earlier integration worktree was changed. PR60/61 are excluded.
No new integration commit, branch merge or PR merge was performed.

NET65 and governance merge cleanly into tree
`0fa645454a0be3ad0e5d91fe195d95bef6f29c44`. The candidate was materialized from
that tree, then the full-index binary diff from PAIR57 `4eede49a` to PAIR67
`c1bedc0` was applied with `git apply --3way --index`. Exactly four files required
resolution:

- `.github/workflows/ci.yml`: retain all NET native lanes and PAIR's late-operation
  lane, Node 24, the required SharedOS pin and full-history validation checkout.
- `package.json`: use PR67's `node scripts/check.mjs` and NET's complete test
  command, including `--test-concurrency=2`.
- `scripts/README.md`: combine the check/helper instructions and bounded NET entry.
- `tests/runner-v1/repository-surface.test.ts`: preserve the combined script
  inventory and give the test a matching description.

The four resolution paths pass `git diff --check`. A whole staged-diff check flags
20,637 existing CRLF lines in imported `pact_net_tasks_v2.json`; its raw bytes
remain exactly those of main/governance, blob
`06fb266578497bd1edd03d17da80f0854cc3c367`. No dataset normalization was made.

## Full check and data checks

From the candidate, using the fixed Node and SharedOS checkout:

```bash
SHAREDEVAL_REQUIRE_SHAREDOS=1 SHAREDEVAL_SHAREDOS_DIR=/path/to/pinned-sharedos pnpm check
python3 -B dataset/pact-net/scripts/review.py dataset/pact-net
python3 -B dataset/pact-net/scripts/test_executable_core.py
npm run export:huggingface:pact-pair
python3 -B dataset/pact-net/scripts/review.py dataset/pact-net --benchmark-ready
```

| Check | Result |
| --- | --- |
| Required-runtime `pnpm check` | Exit 0; catalog/type-check pass; **1005/1005**, zero failures/cancellations/skips; test duration **209.387293666 s** |
| Authored NET consistency review | Exit 0; 60 agents, 166 tasks; **FAIL 0 / WARN 5 / BLOCKER 2** |
| Executable-core fixture check | Exit 0; ten draft tasks pass success, safe-partial, authority, closure and applicable privacy cases |
| Canonical PAIR export | Exit 0; 600 rows, 200 per track, benchmark version 6; data SHA-256 `b5f761dfa54f4b99a346e66e2ea16c2cd107e6ea3d67458ad1da15c3e4d7f51e` |
| Explicit benchmark readiness | Exit 1, **NOT READY**; Alex's external corpus dependency and unvalidated/incomplete gold remain blockers |

These results are distinct from PR67's local 891/892 failure, its unchanged
isolated 27/27 pass, and its successful CI. The candidate retains the previously
reviewed NET test configuration; it does not retroactively repair that failed
single-branch result. See the [per-head record](delivery-status.md).

## Cross-version continuation

The external acceptance helper first creates four unfinished runs under frozen
NET65. A separate invocation uses the candidate against the **same absolute run
paths**, without copying/rebinding checkpoints, changing timestamps or extending
grants. Each CLI stage runs in a fresh process. The helper checks source/runtime
identities, frozen config/profile bytes, existing journals and preserved archives.

```bash
python3 -B verify-pair-net-continuation.py seed /path/to/frozen-net65 /path/to/new-output
python3 -B verify-pair-net-continuation.py resume /path/to/candidate e93d46f934987f380137a684f244fff9f6e66a43 /path/to/new-output
```

Final helper: `pair-net-continuation/v2`, SHA-256
`3425fbcae856eb35fcc8cea4068a29dfd42e2bdfeb55cb235c9af319faf0fd65`.
Both phases exited 0: **20 seed turns + 28 continuation turns = 48 scripted
native actor turns; zero live model calls**.

| Scenario | Committed turns across processes | Final observation |
| --- | --- | --- |
| P-01 success | 2 → 8 → 8 | Five actions, released, v2 score **1** |
| P-01 safe partial | 2 → 8 → 8 | Three actions, held, v2 score **0.175** |
| Multi world | 8 → 9 → 16 → 16 | Five actions per case; B starts at frontiers **20/40/20**, A's resource stays released |
| Single world | 8 → 9 → 16 → 16 | Five actions per case; B starts at **0/0/0** in the new epoch, A's resource is reset |

Old context/record and archived-case bytes are preserved. Completed reopening
adds no effect and changes no JSON values or canonical execution identities.
Every non-export file remains byte-identical on that reopen. The derived
`execution.json` is reserialized in success/Multi/Single, while safe-partial keeps
all bytes unchanged. Unregistered world scoring returns a typed rejection without
altering execution. P-01 scoring verifies exact evaluator, manifest, submission
and launcher hashes, Python CPython 3.13.0 identity, and preservation of all
pre-existing execution files.

This uses synthetic owner evidence. P-01's forbidden-disclosure set is empty;
its safety score does not establish task-level privacy performance. Synthetic
world cases remain unregistered and do not close the two-authored-rubric gate.

### Retained failed first attempt

Helper v1 initially required every run file to remain byte-identical after a
completed reopen. P-01 successfully continued from 2 to 8 turns and reopened at
8 turns, but that assertion failed. The two exported JSON objects and canonical
digests were identical; approval objects changed insertion order after checkpoint
schema parsing. CLI republishes `execution.json` even when no new turn executes.

Source inspection confirmed the mismatch with the export contract. V2 permits
only this export serialization change and still requires complete JSON value/type
equality, all four execution identity fields, identical file inventory and exact
bytes for every other file. It also saves per-stage before/after hash maps and
raw exports. Production code, deadlines and the candidate tree were unchanged.

The v1 helper and failed directory remain intact. That attempt contains 20 seed
turns plus six observed continuation turns and is not counted as a passing run.
V2 used a fresh directory and new seeds; no failed-run recovery or automatic retry
was used. The unchanged candidate's full suite was not rerun for this external
helper correction.

## Independent preservation review and artifacts

A separate read-only review verifies the intended CI/check/inventory union,
**73/73** registry size/hash checks, all 67 governance registry entries, and the
five PAIR entries plus coverage v2. It confirms 33 PR67 files, 16 NET source
changes and four NET scripts against their fixed inputs. Three NET loader/schema
files intentionally come from governance; the inventory test is an explicit
union. This review executed no tests.

Local evidence includes `integration-pair-net-tree-check.log`, the four data
check logs, `integration-pair-net-static-review.md`, and
`pair-net-continuation-e93-v2/{seed-summary,resume-summary}.json` with command,
hash and per-stage records. The failed `pair-net-continuation-c1bedc0` directory
and `verify-pair-net-continuation-v1.py` are retained separately. Raw private PAIR
trial journals are not part of these artifacts or this report.

The final candidate tree remained unchanged with no unstaged/untracked source
files after verification. General NET provider/inventory execution, a second
authored rubric, practitioner validation and the failed PAIR 60-task/adaptive
experiments remain separate gates described in the
[Chinese overview](multi-acceptance.zh-CN.md) and
[next implementation plan](net-provider-execution-plan.md).
