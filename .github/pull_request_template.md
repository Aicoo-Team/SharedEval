## Outcome and ownership

<!-- Describe the concrete trigger and resulting behavior. Keep small changes brief. -->

- Author / accountable owner:
- Reviewer / affected boundary owner (actual person or team; pending if unassigned):
- Owned files/modules and scope:

## Base and dependencies

- Base branch and SHA:
- Head branch and SHA:
- Upstream PRs / required merge order (or none):
- Required SharedOS revision and runtime digest (or unchanged; cite checkout pin):
- Design / ADR (or why no design record is needed):

## Behavior and compatibility

<!-- Explain boundary changes, world versus profile responsibilities, protocol/artifact
versions, data migration, and recovery/rollback consequences where applicable. -->

## Validation evidence

<!-- Record the commands actually run, not planned commands. Attach sanitized logs.
Distinguish pre-existing failures from regressions; a skip is not a pass. -->

| Command | Exit | Passed / failed / skipped | Evidence path or run link |
| --- | --- | --- | --- |
| `npm run check` | | | |

- Checked SharedEval head / SharedOS revision and digest:
- Environment and relevant configuration/task-set identity:
- Evidence achieved: fixture / scripted real-SharedOS / live-model / cold-process
  (state which; describe process boundary and live provider use separately):
- Baseline failures, unrun checks, and acceptance gaps:

## Review checks

<!-- Mark not-applicable items explicitly with a short reason. -->

- [ ] SharedOS remains the only turn and authorization boundary; allow/deny paths
      are covered where permissions changed.
- [ ] Model-visible inputs exclude hidden gold, scoring state, and other actors'
      private histories.
- [ ] Unknown external completion cannot silently retry; completed replay produces
      no new external work where recovery changed.
- [ ] Public/persisted contracts are JSON-safe and versioned; breaking decisions
      have an ADR and migration plan.
- [ ] Claims match actual executable support and evidence; NET validation is not
      presented as NET runtime acceptance.
- [ ] Dependencies and review findings are resolved or have a recorded disposition;
      evidence applies to this head.
