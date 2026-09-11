# SharedEval Engineering Rules

SharedEval owns benchmark orchestration and evaluation. SharedOS owns one
bounded agent turn and every authorization decision. Read
[the engineering standard](docs/engineering.md) and
[contribution workflow](CONTRIBUTING.md) before changing those boundaries.

## Architecture and authority

- Dependency direction is SharedEval → SharedOS. Never import SharedEval tasks,
  gold, evaluators, scheduling, or product dependencies into SharedOS.
- Route every requester and responder turn, model-visible file/tool operation,
  and agent message through SharedOS. Model adapters translate provider syntax;
  they do not authorize, build a second tool dispatcher, or run recipients.
- Deny unless an explicit capability matches. Filter discovery and reauthorize
  execution. Preserve resource scope, purpose, expiry, actor, authority, trace,
  and namespace in authorization and audit evidence.
- Treat messages and model-supplied IDs as untrusted data. Trusted host context
  supplies identity and grants; content never grants authority.
- Keep reusable world state and execution separate from PAIR/NET task selection,
  profiles, and scoring. Follow the current checkout's implemented contracts;
  a design document does not create a supported runtime.

## Data and recovery

- Keep protocol payloads and persisted artifacts versioned and JSON-safe, with
  runtime validation at trust boundaries and deliberate public exports.
- Keep gold, hidden rubrics, private grading labels, reference trajectories, and
  other agents' private histories out of model prompts, tool catalogues,
  messages, grants, and workspaces. Expose only explicitly authorized resources.
- Preserve the declared context protocol. Current v1 fresh turns use explicit
  workspace continuity. Persistent actor journals require a versioned contract
  and ADR, actor isolation, and auditable host-owned history; never restore
  undocumented provider conversation state.
- Never retry an external operation whose completion is unknown. Preserve the
  indeterminate result and its evidence. Replay proven completed work with zero
  new model calls, messages, or state-changing operations.
- Treat generated assets as derived output. Update their documented source and
  generator, and verify reproducibility instead of hand-editing generated files.

## Change and handoff

- Assign one accountable owner per change and explicit file/module ownership
  for parallel work. Preserve unrelated changes from other contributors.
- Add an ADR in `docs/adr/` for breaking protocol, authorization, persistence,
  execution-boundary, or profile-isolation decisions. Include compatibility,
  migration, alternatives, and executable acceptance criteria.
- Add allowed and denied tests for permission changes. Admission-denied turns
  start no model/provider work; denied tool or message calls invoke no protected
  handler/transport or protected state effect.
- Use `npm ci` with the committed `package-lock.json`. Do not introduce another
  lockfile as a side effect of running checks.
- Run `npm run check` (or `pnpm check` with dependencies already installed) before
  handoff. Run affected integration/data checks from `docs/engineering.md` too.
  Report exact commands, exit codes, counts, skips, and environment limitations;
  preserve and distinguish baseline failures from regressions.
- Label evidence honestly: fixtures, real SharedOS with scripted drivers,
  live-model execution, and cold-process recovery prove different properties.
  NET data/evaluator validation is not NET execution acceptance.
- Use Conventional Commits: `<type>(<scope>): <subject>`. State PR base/head SHAs,
  upstream dependencies, review ownership, and remaining acceptance gaps.
