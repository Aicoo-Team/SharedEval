# Codex responder bridge ("Codex 对照")

The bridge runs the PACT-Pair `files-single` workflow with the **responder**
actor driven by OpenAI's Codex CLI instead of the built-in OpenAI-compatible
adapter. The requester stays on the built-in adapter. Everything else in the
run — SharedOS kernel, capability grants, audit, the message router, the
ledger, and the evaluator — is unchanged.

## Where the seam is

SharedOS executes a turn by pulling decisions from a `SoTurnDriver`
(`src/execution/sharedos/v1/contracts.ts`): `open(request)` returns a session,
and the executor calls `next({type:'start'})`, then `next({type:'tool_result'})`
after it has executed each `tool_call` decision, until the session returns
`complete` or `fail`. Tools are executed by the kernel, never by the driver.

`createSharedOsFileSessionV1` already asks for a driver per actor with
`createDriver({ actorId, role })`. The bridge is a second driver
implementation (`src/runner/v1/codex/codex-responder-driver.ts`) that the
production composition hands out when `role === 'responder'` and the run
config names the harness. The requester keeps
`createOpenAICompatibleFileTurnDriverV1`.

Because the seam is below the kernel, the responder's `files.read` calls are
still the reads the router checks for `CONTACT_RESPONDER_FILE_READ_REQUIRED`,
its `files.replace` on MEMORY.md still goes through CAS, and its reply is
still written by `sharedos-message-router.ts` from the `completed` decision.

## Tick lifecycle with Codex

For each responder execution (one per requester contact):

1. `next({type:'start'})` creates a scratch directory
   (`<tmp>/sharedeval-codex-*/`) containing
   - `home/config.toml` — a private `CODEX_HOME` (see below),
   - `cwd/` — an empty working directory Codex is pointed at,
   - `bridge.sock` — a Unix domain socket the driver listens on,
   - `last-message.txt` — where Codex writes its final message (`-o`).
2. The driver spawns
   `codex exec --json --skip-git-repo-check --sandbox read-only -C <cwd>
   -o <last-message.txt> [harness.codex.extraArgs...] -`
   with the prompt on stdin. The environment passed to Codex is only `PATH`,
   `HOME`, `CODEX_HOME`, and `SHAREDEVAL_MODEL_API_KEY` (forwarded from the
   frozen driver environment; never written to disk, never logged).
3. Codex starts the MCP server named in `config.toml`
   (`src/runner/v1/codex/mcp-server-main.ts`, run with this repository's tsx
   loader). The server connects to `bridge.sock`, sends `hello`, and the
   driver replies with the tick's `tools` list projected from
   `request.tools`.
4. Each MCP `tools/call` becomes a bridge `tool_call`. The driver returns it
   to the executor as a SharedOS `tool_call` decision with a stable id
   (`call-<sha256(executionId, step, bridgeId)>`). When the executor comes
   back with the `tool_result`, the driver renders it exactly as the built-in
   driver renders its `tool` message (`{"status":...,"output":...}` or
   `{"status":...,"error":{...}}`) and the MCP server answers Codex with that
   text (`isError` set for non-succeeded results). Codex may issue parallel
   MCP calls; the server serializes them because SharedOS executes one call
   per step.
5. When Codex exits, the driver reads `last-message.txt` (falling back to the
   last `agent_message` item in the `--json` stream). Exit code 0 with a
   non-empty message becomes
   `{type:'completed', content, toolSteps, contactCalls: 0}`; anything else is
   a `fail` decision with code `codex_harness_failed` (stderr tail included,
   credential redacted). Missing executable → `codex_harness_unavailable`.
6. `close()` (or any failure/abort) kills Codex (SIGTERM, then SIGKILL after
   2 s), closes the socket, and removes the scratch directory.

The prompt Codex receives is `renderFileTurnPromptV1(message)` — byte-identical
to the built-in responder's bootstrap text — followed by one preamble
(`CODEX_HARNESS_PREAMBLE_V1`) stating that tools are only available through
the `sharedos` MCP server with `.`→`_` names, that the shell and disk must not
be used, and that the final message is delivered verbatim.

## Codex configuration (`config.toml`)

Rendered per tick by `renderCodexConfigTomlV1`; the values come from the
run's `model` block and `harness.codex`:

```toml
model = "deepseek/deepseek-chat"          # model.model
model_provider = "sharedeval"             # harness.codex.providerId
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sharedeval]
name = "sharedeval"
base_url = "https://openrouter.ai/api/v1" # model.baseUrl
env_key = "SHAREDEVAL_MODEL_API_KEY"      # Codex reads the key itself
wire_api = "chat"                         # harness.codex.wireApi (only value)

[mcp_servers.sharedos]
command = "<node>"
args = ["--import", "<tsx loader>", "<repo>/src/runner/v1/codex/mcp-server-main.ts"]
startup_timeout_sec = 30
tool_timeout_sec = <budget.maxRuntimeMs / 1000>

[mcp_servers.sharedos.env]
SHAREDEVAL_CODEX_BRIDGE_SOCKET = "<scratch>/bridge.sock"

[history]
persistence = "none"
```

## MCP tool list and mapping

The MCP server has no tools of its own. It exposes exactly `request.tools`
for the responder execution, i.e. what `executeResponderTurn` in
`sharedos-file-session.ts` passes: the SharedOS file tools plus the PACT-Pair
task tools. Names are rewritten `.` → `_` (`projectCodexBridgeToolsV1`
refuses a tool set where that rewrite collides); `description` and
`inputSchema` are forwarded unchanged.

| MCP tool (Codex sees) | SharedOS tool (kernel executes) | Source |
|---|---|---|
| `files_read` | `files.read` | SharedOS `@sharedos/os` file tools |
| `files_replace` | `files.replace` | SharedOS `@sharedos/os` file tools |
| `search_notes` | `search_notes` | `src/suites/pact-pair/sharedos-tools.ts` |
| `get_note` | `get_note` | same |
| `create_note` | `create_note` | same |
| `edit_note` | `edit_note` | same |
| `search_todos` | `search_todos` | same |
| `get_todo` | `get_todo` | same |
| `create_todo` | `create_todo` | same |
| `edit_todo` | `edit_todo` | same |
| `complete_todo` | `complete_todo` | same |

`messages.request` is not in the responder's tool list today and is
therefore not exposed (the responder has no contact tool; `contactCalls` is
always 0).

The MCP surface implemented: `initialize`, `notifications/initialized`,
`ping`, `tools/list`, `tools/call`. Anything else returns JSON-RPC `-32601`.
Unknown tool names or non-object arguments are refused locally with `-32602`
and never reach SharedOS.

## How the reply is written back

Nothing about write-back is Codex-specific. The driver returns the same
`FileTurnDecisionV1` the built-in driver returns; `SharedOSExecutor` places
it in `execution.output`; `SharedOsMessageRequestRouterV1.resolveReply`
parses it with `fileTurnDecisionV1Schema`, checks read coverage, and builds
the reply envelope `{taskId, status:'completed', response: content}` with the
stable id `message-<sha256(['message-reply', request.id])>`. The reply
lands in the same messages record, the same audit window, and the same
per-tick evidence as before.

## Evaluator replay stays byte-compatible

- The ledger, evidence, and public projection schemas are untouched; the
  only new bytes are the run config's optional `harness` block and the
  responder's `models.responder.provider = "codex"` in run provenance (its
  `requestedModel`/`resolvedModel` remain the run's model id).
- `configDigest` of any pre-existing config is unchanged: the `harness`
  key is optional and absent keys never enter the canonical JSON
  (`tests/runner-v1/codex-harness-config.test.ts` pins the digests recorded
  at 9c29358).
- Tool-call ids, tool-result rendering, the `completed` decision shape, and
  the reply envelope are produced by the same code paths and formats as the
  built-in driver, so the evaluator's replay of the messages record and the
  responder's file operations is unchanged.
- Provider telemetry records one request per Codex launch with
  `provider: "codex"` and the token usage Codex reports in its `--json`
  `turn.completed` events (`servedModel` is absent; the run-wide served-model
  ledger is not consulted for the responder under this harness).

## Run configuration

```yaml
harness:
  responder: codex
  codex:                      # optional; defaults shown
    command: codex            # executable, resolved through PATH
    providerId: sharedeval    # name of the generated model_providers table
    wireApi: chat             # the only supported value
    # extraArgs: ["--model-reasoning-effort", "low"]  # extra `codex exec` flags
```

`harness` is rejected unless `model.provider` is `openai-compatible`. The
model credential is `SHAREDEVAL_MODEL_API_KEY` in the environment, as for
every run; SharedEval only ever forwards the variable to the Codex child.

## Out of scope

- `denied` decisions: Codex has no refusal channel; a refusal is whatever
  Codex writes as its final message and is scored as a completed reply.
- Codex as the requester, or Codex in `files-multi`. The wiring keys on
  `role === 'responder'` only; multi is not blocked but untested.
- Codex's own reasoning traces, session logs, and the raw `--json` stream
  are not captured into the run artifacts (only usage totals and the last
  message survive). Persisting them under `output.saveTraces` is a follow-up.
- The served-model invariant (`model_identity_mismatch`) is not enforced for
  the Codex side; Codex does not surface the served model id.
- Codex's system prompt, tool-call batching, and retry behaviour are Codex's
  own; the bridge only guarantees the SharedOS-visible surface is identical.
- No MCP resources/prompts, no MCP streaming, no MCP SDK dependency: the
  server is a minimal hand-written stdio JSON-RPC implementation.

## Files

- `src/runner/v1/codex/bridge-protocol.ts` — socket protocol, tool
  projection, result rendering, line splitter.
- `src/runner/v1/codex/mcp-server.ts`, `mcp-server-main.ts` — stdio MCP
  server (stream-agnostic core + process entry).
- `src/runner/v1/codex/codex-responder-driver.ts` — the `SoTurnDriver`.
- `src/runner/v1/codex/codex-harness-config.ts` — the `harness` schema.
- `src/runner/v1/sharedeval-config.ts`, `sharedeval-production.ts` — wiring.
- `tests/runner-v1/codex-*.test.ts`, `tests/runner-v1/codex-fake-cli.ts` —
  tests with a fake Codex process (no real binary, no model calls).
- `scripts/experiments/codex-responder-smoke.sh` — gated one-task smoke
  with the real CLI.
