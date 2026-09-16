# PACT-Pair `simple` profile — handoff

Status: in progress. Verification numbers in "Where it stands" are filled in
from the last run and are the part to re-check first.

## What this changes and why

PACT-Pair is meant to be two agents talking. Under the original (`strict`)
profile a requester could not say anything until it had spent four tool calls
reading `AGENT.md`, `HEARTBEAT.md`, `POLICY.md` and `MEMORY.md`, and the
responder had to do the same before it was allowed to reply. A live DeepSeek run
spent all 32 of its tool calls looping on those reads and never asked its
question; another invented a task id while trying to batch them.

`pairProfile: simple` does two things:

- **The four files are injected into the turn prompt**, together with the exact
  `expectedVersion` for `files.replace`. The agent starts its turn already
  holding what it needs.
- **Capabilities are standing, not per-task.** Permissions follow the
  relationship between the two agents, not the individual question. There is no
  per-task grant set to bind, so `responderGrantSets` is empty.

`pairProfile` is optional and absent means `strict`, so every pre-existing run
config, binding and digest is unchanged.

## The part that cost the most: one contract written four times

"An authoritative contact requires complete four-file read coverage" is not
enforced in one place. It is enforced in four, and injecting the workspace
breaks all of them at once:

| Layer | Location | What it demands |
|---|---|---|
| Message router — requester | `sharedos-message-router.ts:288` | requester read coverage before a contact |
| Message router — responder | `:423` | responder read coverage before a reply |
| Message router — replay | `:534` | coverage again on authoritative replay |
| Evidence projection | `file-workflow-sharedos-evidence.ts:261/267` | complete coverage for a contact |
| Evidence projection | `:977` → `assertRequesterReadsPrecedeContact` | reads ordered *before* contact authorization |
| Ledger | `file-workflow-ledger.ts:1055/1068` | coverage again on the committed contact |

Waiving only the first one produces a failure that points nowhere near the
cause: every request is refused, no contact survives, the requester still writes
`MEMORY.md`, and the run dies on `Every requester terminal MEMORY delta requires
a current terminal outcome` — an error about heartbeat planning, three layers
away from the read gate that actually refused the contact.

`pairProfile` reaches all six sites through `binding.scheduler`, the channel
`multiTurn` already uses. Every call site already holds the binding, so no
function needed a new parameter.

### Waived, never faked

There was a shortcut here worth naming, because it looks attractive and is
wrong. The runtime could have satisfied these assertions itself: read the four
files through the provider path as the agent, on the same trace, and the
coverage checks would all pass with no waivers at all.

That would mean synthesizing `files.read` `tool.invoked` events the model never
issued. `assertRequesterReadsPrecedeContact` specifically checks that those
events precede contact authorization — so passing it requires fabricating a
record of model behavior. The benchmark's entire worth rests on that evidence
being real. The waiver is explicit and profile-scoped instead.

## The second trap: the test double drifted from the system

After the four layers were waived the scripted harness still failed at tick 1
with zero contacts. The cause was not in the production path at all.

`scripts/experiments/run-pair-scripted.ts` plays both actors by matching regexes
against the turn prompt. It decides the protocol phase with
`/Finalization window/`. Injection appends `HEARTBEAT.md` — the document that
*describes* the protocol — into that same prompt, and its line 42 is
`## Finalization window`. So every tick matched the finalization branch: the
scripted requester marked the task refused and never sent a single
`messages.request`. `POLICY.md` carries the task queue and is the same hazard for
the responder's `taskId` pattern.

Fix: `splitScriptedPrompt()` separates the scheduler's instruction from the
injected workspace, and all phase, task and strategy detection runs on the
instruction alone. An unprofiled prompt has no marker and passes through
byte-identical.

**The more dangerous half of this:** the scripted endpoint also read the four
files unconditionally. Fixing only the regex would have produced a *green* run
that exercised none of the waived gates — a false pass. Under injection the
endpoint now skips the reads and takes `MEMORY.md` content and version from the
prompt, which is what a real model does under this profile.

## Contradictory prompt (found from a real artifact)

The driver appended its read guidance *after* the injected workspace, so the
prompt argued with itself:

```
MEMORY.md expectedVersion for files.replace: 0
These four files are current as of this turn; you do not need to read them again.

Before any other action, call files.read for AGENT.md, HEARTBEAT.md, POLICY.md, and MEMORY.md; all four successful reads are required in this turn.
```

This was initially filed as cosmetic. It is not: it is a direct reason a real
model keeps reading the four files under `simple`. `promptFromMessage` now omits
the read guidance and the recipient bootstrap when the payload carries the
injected workspace, keyed off `INJECTED_WORKSPACE_MARKER_V1` — one exported
constant shared by the writer and both readers, rather than a third copy of the
literal.

## Debugging affordance added

`FileWorkflowHeartbeatRecoveryResult`'s cause summary is sanitized to a fixed
vocabulary before it reaches a record. That is right for the artifact and
blinding while developing: the stage survives, the reason does not. Guessing the
throw site from call sites cost two rounds and was wrong both times.

`SHAREDEVAL_DEBUG_HEARTBEAT_CAUSE=1` now writes the original error and stack to
stderr, and nothing else changes — no notice, no payload, no ledger. One run
with it produced the real assertion immediately. Prefer it over reading call
sites.

## Two corrections I made to my own conclusions

Both are recorded because each nearly caused a wrong change:

1. **"Injection is not running."** My check read `message.content` of an
   arbitrary record. The injected prompt lives at `.input.content`, and the
   record I sampled was the wrong one. Injection was working the whole time; I
   was about to unpick correct code.
2. **"Six requests were refused by the responder gate."** `scripted_summary`'s
   `requests` counts completion calls to the fake endpoint (six assistant
   turns), not `messages.request` calls. The whole causal chain I built on it was
   wrong. The requester had sent *zero* contacts.

The lesson both share: an artifact field means what the code that writes it
says it means, and one run with a diagnostic beats two rounds of reading.

## Where it stands

- Four-layer waiver: committed, full suite green.
- Diagnostic hook: committed.
- Scripted endpoint split + read skip, driver prompt fix: written, verification
  in progress.

### What "working" must mean for the scripted run

Do not accept exit code 0. The earlier lesson stands: a passing run is not
evidence that the configuration you believe is running actually ran. Check:

- `contacts > 0` (it was pinned at 0 through every failure above);
- the requester's actor-context records contain **no** `files.read` call — this
  is what proves the waived gates were actually exercised rather than bypassed
  by a harness that read the files anyway;
- the turn prompt no longer contains `Before any other action, call files.read`;
- `responder-bindings: 0` and `deferredSets: 0` in the grant manifest, the
  fingerprint that the run really used `simple`.

## Known flake, unrelated

`rejects FIFO records without blocking the operation lane`
(`tests/runner-v1/sharedos-session-store.test.ts`) fails intermittently under
full-suite concurrency, with a killed child process and empty stdout. Proven
flaky: the unmodified baseline worktree fails it too, three isolated reruns pass,
and it matches the room's 2026-09-13 record. Evidence in
`FIFO-FLAKY-EVIDENCE.txt`. It is not related to this profile.

## Still open

- Tool surface: the requester should get read/search/grep/replace and the
  responder a constant tool set, replacing the per-task `surfaces.has()` gating
  and the QA write-tool filtering in `sharedos-tools.ts`.
- A fabricated-taskId RED→GREEN test: one malformed contact should cost its
  task, not the whole run. Today a single bad `taskId` anywhere in 180 ticks
  ends everything, even when the model corrects itself in the same turn. This is
  the single biggest cause of long runs dying early.
