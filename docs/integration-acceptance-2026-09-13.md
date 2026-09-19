# Combined-tree verification — 2026-09-13

This report covers an isolated integration candidate. It does not record a
source commit, integrated branch, PR merge or push. The required-runtime full
check and four-mode CLI verification passed; authored-world benchmark readiness
remains blocked. Their results and independent file inspection are separate below.

## Tested identity and scope

| Input or object | Exact identity |
| --- | --- |
| Current main | `dc5d482403bd5dfb38ab6af92db399d6cbea3121` |
| NET scoring PR65 | `5da4785c781cd660fd3c41cc42cdbe137f895f32` |
| Governance PR58, already descended from that main | `6c512c03df6a06b7ffd57da4c6539ba8f4e4f5fb` |
| Combined tree under verification | `8a80569f08b34bc8deb1b500b3b5ac377eeea645` |
| SharedOS revision | `3aa07e33999b656a10ace294fd4e41df8cbc318e` |
| SharedOS four-package runtime digest | `4afb23d79851a83a48e25e968f04e45cefc81847b4a9963c62277b5c05862d5d` |

The supervisor combined PR65 and PR58 with `git merge-tree --write-tree`;
Git reported no textual conflicts. A **fresh** `integration-scoring-check`
worktree has detached HEAD at PR65 and the combined tree staged in its index.
The staged tree above is the tested source object. Results must not be attributed
to unchanged PR65 commit contents. The earlier integration directory was not
reused.

Scope includes main's authored NET data and legacy-path registry updates, the
completed NET stack through PR65, and governance standards. PR60, PR61, PR66 and
the new PAIR recovery work are excluded. No model calls or original PAIR trials
are part of this verification. This report was written afterward on the
governance branch and is **not** contained in the tested tree.

## Reproduction

Start in a repository containing the three input commits. Replace the paths
below with a new checkout location, Node 24.18.0 and a clean, built SharedOS
checkout at the declared pin. Do not reuse an existing verification directory.

```bash
combined_check_dir='/absolute/path/to/new-integration-checkout'
test ! -e "$combined_check_dir" || exit 1
combined_tree=$(git merge-tree --write-tree \
  5da4785c781cd660fd3c41cc42cdbe137f895f32 \
  6c512c03df6a06b7ffd57da4c6539ba8f4e4f5fb) || exit 1
test "$combined_tree" = 8a80569f08b34bc8deb1b500b3b5ac377eeea645 || exit 1
git worktree add --detach "$combined_check_dir" \
  5da4785c781cd660fd3c41cc42cdbe137f895f32 || exit 1
git -C "$combined_check_dir" read-tree -m -u HEAD "$combined_tree" || exit 1
cd "$combined_check_dir" || exit 1
test "$(git write-tree)" = "$combined_tree" || exit 1
git diff --quiet || exit 1

export PATH="/absolute/path/to/node-v24.18.0/bin:$PATH"
export SHAREDEVAL_SHAREDOS_DIR='/absolute/path/to/clean-built-pinned-SharedOS'
export SHAREDEVAL_REQUIRE_SHAREDOS=1
node --version
npm ci || exit 1
pnpm check
combined_check_exit=$?

test "$(git write-tree)" = "$combined_tree" || exit 1
git diff --quiet || exit 1
test "$combined_check_exit" -eq 0
```

`git diff --quiet` checks for unstaged source changes; the intended staged diff
against detached HEAD remains present. Capture the full-check output and exit
code separately from the final tree checks. Loader verification enforces the
SharedOS revision, clean build and runtime digest before required native tests.

Run the additional data checks from the same candidate:

```bash
python3 -B dataset/pact-net/scripts/review.py dataset/pact-net
python3 -B dataset/pact-net/scripts/test_executable_core.py
npm run export:huggingface:pact-pair
```

Record readiness separately; its blockers are not ordinary consistency failures:

```bash
python3 -B dataset/pact-net/scripts/review.py dataset/pact-net --benchmark-ready
```

The executed fixture-check command included a trailing `dataset/pact-net`
argument. That script ignores arguments and resolves its own dataset directory;
the argument-free command above reproduces the same check without implying a
configurable root. `-B` suppresses Python bytecode caches.

## Observed results

| Check | Observed result |
| --- | --- |
| Required-pin `pnpm check` | Exit 0, Node 24.18.0; catalog validation and type-check passed; **903/903 tests**, zero failures/cancellations/skips, **185.606 s** |
| Authored NET consistency review | Exit 0; **60 agents, 166 tasks; FAIL 0 / WARN 5 / BLOCKER 2** |
| Ten-task executable-core fixture self-test | Exit 0; **10 draft tasks** passed success, safe-partial, authority, closure and applicable privacy cases |
| Canonical PAIR export check | Exit 0; **600 rows: 200 notes QA / 200 todo QA / 200 actions**, benchmark data version **6** |
| Explicit `--benchmark-ready` review | **Exit 1, NOT READY**; FAIL 0 / WARN 5 / BLOCKER 2, retained separately from ordinary consistency success |
| Additional combined-tree e2e | Exit 0, four modes below; separate CLI processes, **48 scripted turns / zero model calls**, final tree unchanged |

The additional CLI verification ran directly from this materialized tree with
fresh synthetic output directories and the required SharedOS pin:

| Scenario | Committed turn counts across processes | Outcome |
| --- | --- | --- |
| P-01 success | 2 → 8 → 8 | Five actions, released, explicit v2 score **1** |
| P-01 safe partial | 2 → 8 → 8 | Three actions, held, explicit v2 score **0.175** |
| Two-case Multi | 8 → 9 → 16 → 16 | Five actions per case; B begins with actor frontiers 20/40/20 and retains A's released resource |
| Two-case Single | 8 → 9 → 16 → 16 | Five actions per case; B begins with actor frontiers 0/0/0 and resets A's resource |

Each completed reopen preserved the final snapshot without adding effects.
Earlier case event archives remained intact; world scoring rejected the
unregistered fixture instead of borrowing P-01's evaluator. Partial P-01 evidence
was rejected for scoring before completion. This is scripted real-SharedOS
integration, not a live-model or general task-set result. Reproduce the supported
commands using [the fixed-head native CLI guide](https://github.com/Aicoo-Team/SharedEval/blob/5da4785c781cd660fd3c41cc42cdbe137f895f32/docs/pact-net-native-cli.md); the committed
`tests/runner-v1/net-native-conformance.test.ts` covers these cold-process paths
and additional invalid-evidence, legacy-entry and scoring-provenance cases.

The PAIR export data SHA-256 is
`b5f761dfa54f4b99a346e66e2ea16c2cd107e6ea3d67458ad1da15c3e4d7f51e`.
The two authored-world readiness blockers are Alex's external PACT-Pair corpus
dependency and incomplete practitioner-validated gold: **0 validated, 10 draft
executable, 156 not built**. An ordinary review exit of 0 does not close them.
These data/fixture checks do not establish general NET execution or benchmark
readiness.

The ordinary `check` already validates the catalog and legacy NET assets and
includes registry tests. It does not run the separate authored-world Python
checks above. `review.py` recomputes agent-set and discovery consistency in
memory, so separate generator invocations are unnecessary.

## Independent read-only inspection

A separate reviewer inspected the materialized candidate without modifying files
or running native tests. Nine selected CI/package/script/runtime/scoring files
were byte-identical to PR65; four governance standard/template files matched
PR58; six selected NET manifest/checker/index/task files matched main. This is a
bounded comparison, not a claim of an independent full-tree execution.

The merged workspace registry retains all **67 main entries unchanged** and
adds the five existing PAIR-stack entries, for **72** total. Independent reads
checked operational byte lengths and SHA-256 values, provenance source hashes,
and exact-provenance byte equality across all 72 entries, with **zero
mismatches**. This scan did not independently recompute derived transformations;
the full suite contains the registry's broader provenance tests.

The candidate preserves Node 24 in both CI jobs, the `3aa07e3` runtime pin and
all mandatory native lanes, including NET world and CLI/scoring. The governed
script inventory retains the supported exporter, four bounded NET entry scripts
and eleven experiment scripts. No experiment helper was executed. Historical
`dc5d482` pin/scope statements in the engineering standard remain explicitly
historical; README, running instructions, loader and CI identify the candidate's
current bounded NET surface and pin consistently.

After the full check, data checks and CLI verification, `git write-tree` still
returned `8a80569f08b34bc8deb1b500b3b5ac377eeea645`, with no unstaged or
untracked source changes. The intended staged integration diff remains present.
This tree has no separate GitHub CI run; the independently passing source-PR
runs are not relabelled as combined-tree CI.

The supervisor retained the full command outputs as
`integration-scoring-tree-check.log`, `integration-scoring-net-review.log`,
`integration-scoring-python-pilot.log`, `integration-scoring-pair-export.log`,
`integration-scoring-benchmark-ready.log` and `integration-scoring-cli-e2e.log`.
`integration-scoring-acceptance-8a80569/` contains the synthetic CLI configs,
command outputs, per-stage snapshots, runs and final `summary.json`; its external
driver is `verify-integration-scoring-cli.py`. These are local audit artifacts,
not private PAIR trial data or files included in this documentation commit.
