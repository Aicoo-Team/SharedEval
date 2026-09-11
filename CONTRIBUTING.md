# Contributing to SharedEval

Start with [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), and the
[engineering standard](docs/engineering.md). The rules apply to human and agent
contributors alike.

## Set up and establish a baseline

Use Node.js 20.11 or newer and the committed npm lockfile:

```bash
npm ci
npm run check
```

`check` runs catalog validation, TypeScript checking, and the test suite in that
order, stopping at the first failure. It does not call a live model. The test
suite can skip real SharedOS cases when no build is available; report those
skips. `pnpm check` may invoke the same script after `npm ci`; dependency
installation and lockfile maintenance remain npm-based.

Before editing, record the base commit and affected checks. If the baseline is
red, preserve the command output and compare failures after the change. A known
failure remains an open acceptance gap; it is not a passing result.

## Scope and design

Give each PR one concrete outcome and an accountable author. Declare file or
module ownership before parallel implementation; do not revert another
contributor's work. Use an isolated branch or worktree when work overlaps.

For a local fix, explain the trigger, changed behavior, and validation in the
PR. For a feature spanning boundaries, write a short design using the required
fields in [the engineering standard](docs/engineering.md#design-records).
Breaking protocol or authority decisions require an ADR in `docs/adr/`.

Keep changes reviewable. Separate prerequisite contracts, execution work,
profile integration, and acceptance evidence when they have different review
owners or dependencies. Use Conventional Commits, for example
`feat(runner): preserve task order across heartbeats` or
`docs(engineering): define execution acceptance evidence`.

## Validate and submit

Run `npm run check` and the affected checks listed in
[validation and evidence](docs/engineering.md#validation-and-evidence). Do not
add tests that merely restate prose; retain meaningful contract, allow/deny,
recovery, and integration coverage for behavior changes.

Fill in the [PR template](.github/pull_request_template.md). Include:

- the user-visible outcome, scope, author, and actual reviewer/owner;
- exact base branch/commit and head branch/commit;
- upstream PRs and required SharedOS revision/digest, or explicitly none;
- design/ADR links, compatibility impact, and migration or rollback behavior;
- actual commands, exit codes, test counts/skips, and evidence artifact paths;
- current limitations and the precise acceptance tier achieved.

For stacked PRs, target the immediate prerequisite branch and identify the
whole dependency chain. A reviewed downstream diff is not proof that its
upstream PR merged. After the prerequisite lands, retarget/rebase as needed,
inspect the new diff, and rerun affected checks on the new head. Record upstream
merge SHAs and any conflicts resolved. Do not merge a dependent change while
its required runtime/contract version is unavailable.

Before marking a PR ready, resolve review findings or record an explicit
maintainer disposition. Check results and acceptance claims must refer to the
head being reviewed. Keep credentials and raw private model traces out of PRs;
link sanitized evidence and state where restricted evidence is retained.
