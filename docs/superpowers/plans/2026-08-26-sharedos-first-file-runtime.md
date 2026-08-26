# SharedOS-first SharedEval Runtime Implementation Plan

> **For agentic workers:** use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`, apply TDD task by task, and obtain an
> independent review before advancing.

**Goal:** Ship only `multi` and `single`. Every requester/responder turn,
model-visible file or benchmark tool call, and request/reply message runs
through SharedOS. No-mode `sharedeval` selects `multi`. Historical execution
substrates are deleted, not migrated or maintained.

**Boundary:** SharedOS owns turn admission, tool discovery, invocation
authorization, message authorization, timeout/cancellation, result status, and
audit. SharedEval owns scheduling, durable host storage, dataset selection,
task correlation, evaluation, recovery policy, and artifacts.

**Specs:** `docs/adr/0001-agent-workspace-v1.md` and
`docs/adr/0002-sharedos-first-execution-plane.md`.

## Fixed decisions

- SharedOS revision: `a303d97fe974c149d4575b1f5d6426aee6f37367`.
- Production package digest:
  `faefbf2ae61ffdcaf57f76e0c5b9b3f1438790213c0f16b3e02905bdbcba37cb`.
- Load only `@aicoo/sharedos-contracts`, `@aicoo/sharedos-core`,
  `@aicoo/sharedos-os`, and `@aicoo/sharedos-runtime`.
- One host-selected purpose: `sharedeval:pact-pair`. `intent` does not exist.
- This release executes only `pact-pair`. Reject `pact-net` before any model,
  workspace, or SharedOS work; retain its dataset/evaluation validation only.
- A heartbeat is the only recovery boundary. Replay a durable completed
  heartbeat with zero external work. A start without a completed record is
  `indeterminate_external_operation` and is never retried automatically.
- There is no maintained local/reference runtime, no legacy directory, and no
  differential path. Git history is the archive.
- All run grants are immutable root grants with no `parentGrantId` or
  `delegationDepth`; dynamic issuance and delegation are unsupported and fail
  closed in this release.
- Both actors may read their own four workspace files and may replace only
  their own `MEMORY.md`, after reading its current version, at most once
  successfully per turn.
- Shared `maxToolCalls` defaults to 8 and is rejected below 6. Six is the
  smallest requester budget that covers four required reads, one MEMORY
  replacement, and one request; the responder uses the same bounded budget.
- Do not push, publish, open or merge PRs, rename or transfer repositories,
  delete remote branches, or touch either user checkout in this plan.

## Canonical identities

All IDs hash canonical JSON tuples. Array positions and JSON boundaries prevent
concatenation collisions.

```ts
namespaceId = stableId("namespace", ["namespace", runId, sessionIndex]);
heartbeatId = stableId("heartbeat", ["heartbeat", namespaceId, tick, inputDigest]);
eventId = heartbeatId;
traceId = stableId("trace", ["trace", heartbeatId]);
requesterExecutionId = stableId("execution", [
  "requester-execution",
  heartbeatId,
  requesterId,
]);
toolCallId = stableId("call", ["tool-call", executionId, step, providerCallId]);
operationId = toolCallId;
requestMessageId = stableId("message", [
  "message-request",
  namespaceId,
  traceId,
  toolCallId,
  recipientAddress,
]);
responderExecutionId = stableId("execution", [
  "responder-execution",
  requestMessageId,
  responderId,
]);
replyMessageId = stableId("message", ["message-reply", requestMessageId]);
grantId = stableId("grant", [
  "grant",
  namespaceId,
  subjectAddress,
  capabilityNamespace,
  resourcePath,
  actions,
]);
```

`stableId(prefix, tuple)` is `prefix + "-" +` the first 40 hexadecimal
characters of `sha256(canonicalJson(tuple))`. Provider IDs are untrusted tuple
data, never authority.
`recipientAddress`, `subjectAddress`, and `actions` are their canonical parsed
JSON values; action arrays are sorted before hashing.

The authority and owner are
`{kind:"service",serviceId:"sharedeval"}`. `GrantSource.load(context)` returns
only grants whose namespace, subject, and issuer equal that trusted context.
Responder task grants are selected from an immutable accepted-request
ID/trace/task binding, never from message payload.

Every manifest grant has immutable `issuedAt: runStartedAt`, no parent or
delegation field, and
`constraints:{purposes:["sharedeval:pact-pair"],notBefore:runStartedAt,maxUses}`.
There is no invented wall-clock TTL: a durable closed-session marker makes the
host `GrantSource` return no grants, while an open crashed run may be resumed
under its original immutable binding.

The requester context enables only `files` and `messages`; its exact requested
tool ceiling is `files.read`, `files.replace`, and the pinned core export
`MESSAGE_REQUEST_TOOL_DEFINITION`. The responder context enables only `files`
and `pact-pair`; its exact requested ceiling is `files.read`, `files.replace`,
and the host-bound task tools. It never receives `messages.request` or the
`messages` namespace. Trusted host code sends a terminal reply through
`kernel.sendMessage`, which consumes the responder's recipient-scoped send
grant without exposing a recursive message tool to the model.

## Exact grants and PACT-Pair requirements

| Grant | Resource/action | `maxUses` |
| --- | --- | ---: |
| requester execution | `sharedos.execution/addressPath(requester):invoke` | `maxTicks` |
| responder execution | `sharedos.execution/addressPath(responder):invoke` | selected task count |
| actor file read | `files/[actorId,filename]:read`, one grant for each of four files | actor turn count × `maxToolCalls` |
| actor MEMORY replace | `files/[actorId,"MEMORY.md"]:replace` | actor turn count |
| requester request | `sharedos.messaging/["agent",responderId]:send` | selected task count |
| responder reply | `sharedos.messaging/["agent",requesterId]:send` | selected task count |
| responder task tools | `pact-pair/["task",taskId,surface]` with exact actions below | `maxToolCalls` for that task turn |

The grant manifest builder creates one stable grant per row above. For each
accepted task it creates one responder task grant. QA grants include `read`
only; action grants include `read`, `create`, and `update` for the task surface.
Every capability has `scope:"exact"`, its resource owner is the fixed
SharedEval service owner, and no wildcard action or descendant resource is
issued.
The per-turn task workspace is already restricted to that surface and excludes
system note folders; this is a host data view, not an authorization decision.

| Tool | Surface | SharedOS action |
| --- | --- | --- |
| `search_notes`, `get_note` | notes | `read` |
| `create_note` | notes | `create` |
| `edit_note` | notes | `update` |
| `search_todos`, `get_todo` | todos | `read` |
| `create_todo` | todos | `create` |
| `edit_todo`, `complete_todo` | todos | `update` |

Each responder turn registers only tools for its host-bound task surface.
Every handler's `resolveRequirement` closes over the accepted task binding and
returns exactly `pact-pair/["task",taskId,surface]:action`. Handlers receive no
boundary/access plan and perform no grant decision.

---

### Task 1: Collapse the repository to one runtime boundary

This task removes every competing execution plane immediately. It also creates
the minimum contracts and model driver needed for retained scheduler tests to
use a fake `SharedOsFileSessionV1`; no production fallback is left behind.

**Create:**

- `src/contracts/json.ts`
- `src/contracts/benchmark.ts`
- `src/execution/sharedos/v1/contracts.ts` (rewrite)
- `src/runner/v1/model-config.ts`
- `src/runner/v1/file-turn-contracts.ts`
- `src/runner/v1/file-model-driver.ts`
- `src/runner/v1/sharedos-file-session-contracts.ts`
- `src/suites/pact-pair/public-evaluation.ts`
- focused tests with matching names under `tests/`.

**Modify retained code:**

- `src/execution/sharedos/v1/{index,load-sharedos}.ts`
- `src/runner/v1/{openai-compatible-client,sharedeval-cli,sharedeval-config,sharedeval-runner,workflow,workspace-registry,file-workflow-artifacts,file-workflow-ledger,index}.ts`
- `src/suites/pact-pair/{file-workflow,files-multi,files-single,tools,evaluator,task-loader,index}.ts`
- `src/suites/pact-net/{evaluator,task-loader,index}.ts`
- `src/validate.ts`
- `tests/runner-v1/{sharedeval-cli,sharedeval-config,workspace-registry,file-workflow-artifacts,file-workflow-ledger}.test.ts`
- `tests/runner-v1/file-workflow-test-fixtures.ts`
- `tests/suites/pact-pair/{files-multi,files-single,evaluator,task-loader,workspace}.test.ts`
- `tests/suites/pact-pair/data-schema.test.ts` (remove assertions for the
  deleted experiment script; retain canonical task/store/schema checks)
- `package.json`, `.github/workflows/ci.yml`, `.gitignore`, and the public docs
  named below.

`src/execution/sharedos/v1/contracts.ts` owns the structural dynamic-loader
types `SoTurnDriver`, `SoToolCall`, `SoToolResult`, `SoAuditEvent`, and
`SharedOsModulesV1`. `SharedOsModulesV1` contains exactly the four production
modules above. `src/contracts/json.ts` owns JSON-safe schemas, complexity limits,
and safe relative paths. `src/contracts/benchmark.ts` owns the retained public
identity/task/terminal-decision/tool-definition shapes. `sharedeval-config.ts`
owns the runtime budget schema (hard maximum `600_000`) and command task
selection; `pact-pair/task-loader.ts` continues to own the PACT-Pair task filter.

`model-config.ts` owns model schemas/types, model identifier, and credential
resolution. `public-evaluation.ts` owns both public and full evaluation
schemas/types plus `toPublicEvaluation`. `file-turn-contracts.ts` owns the
three valid model decisions: `completed`, `denied`, and `cancelled`.
`file-model-driver.ts` owns `FileProviderTelemetryV1` and the read-only
`FileProviderTelemetrySourceV1` interface in addition to the pure turn driver.
Its only factory is
`createOpenAICompatibleFileTurnDriverV1(options): SoTurnDriver & FileProviderTelemetrySourceV1`;
the options contain model config, optional requested model, fetch, and
environment—nothing else.

The structural runtime boundary is exact:

```ts
type SoAddress =
  | { kind: "human"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "group"; conversationId: string }
  | { kind: "service"; serviceId: string };
type SoExecutionStatus =
  | "succeeded"
  | "denied"
  | "failed"
  | "cancelled"
  | "escalated";
type SoProtocolError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
};
type SoRuntimeVisibleContext = {
  actor: SoAddress;
  owner: SoAddress;
  namespaceId: string;
  purpose: string;
  traceId: string;
  now: string;
};
type SoMessageEnvelope = {
  version: "1";
  id: string;
  sender: SoAddress;
  receiver: SoAddress;
  purpose: string;
  payload: JsonValue;
  traceId: string;
  replyTo?: string;
  createdAt: string;
};
type SoToolDefinition = {
  name: string;
  description: string;
  namespace: string;
  source: string;
  readWrite: "read" | "write";
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  requiredCapability: {
    resource: { namespace: string; path: string[]; owner?: SoAddress };
    action: string;
  };
};
type SoAccessContext = {
  namespaceId: string;
  actor: SoAddress;
  authority: SoAddress;
  owner: SoAddress;
  purpose: string;
  traceId: string;
  enabledToolNamespaces: readonly string[];
  now: string;
};
type SoCapabilityGrant = {
  id: string;
  namespaceId: string;
  subject: SoAddress;
  issuer: SoAddress;
  capabilities: readonly {
    resource: { namespace: string; path: string[]; owner?: SoAddress };
    actions: readonly string[];
    scope: "exact" | "descendants";
  }[];
  constraints: {
    purposes?: readonly string[];
    notBefore?: string;
    expiresAt?: string;
    maxUses?: number;
    delegationDepth?: number;
  };
  issuedAt: string;
  revokedAt?: string;
  parentGrantId?: string;
  metadata?: JsonObject;
};
interface SoGrantSource {
  load(context: SoAccessContext, signal: AbortSignal): Promise<readonly SoCapabilityGrant[]>;
}
interface SoGrantUsageStore {
  getUsage(namespaceId: string, grantId: string): Promise<number>;
  tryConsume(namespaceId: string, grantId: string, maximumUses: number): Promise<boolean>;
}
interface SoAuditSink {
  record(event: SoAuditEvent): Promise<void>;
}
interface SoMessageTransport {
  deliver(
    context: SoAccessContext,
    envelope: SoMessageEnvelope,
    signal: AbortSignal,
  ): Promise<SoMessageDeliveryResult>;
}
interface SoMessageRequestRouter {
  resolveReply(
    context: SoAccessContext,
    request: SoMessageEnvelope,
    delivery: SoMessageDeliveryResult,
    signal: AbortSignal,
  ): Promise<SoMessageEnvelope>;
}
interface SoResourceProvider {
  namespace: string;
  invoke(operation: SoResourceOperation, signal: AbortSignal): Promise<SoResourceResult>;
}
type SoToolCall = {
  id: string;
  tool: string;
  arguments: JsonObject;
  traceId: string;
  requestedAt: string;
};
type SoToolResult = {
  callId: string;
  tool: string;
  status: "succeeded" | "denied" | "failed";
  output?: JsonValue;
  error?: SoProtocolError;
  completedAt: string;
};
type SoTurnInput =
  | { type: "start" }
  | { type: "tool_result"; result: SoToolResult };
type SoTurnDecision =
  | { type: "tool_call"; call: SoToolCall }
  | { type: "complete"; output: JsonValue; metadata?: JsonObject }
  | { type: "fail"; error: SoProtocolError };
interface SoTurnDriver {
  open(
    request: {
      version: "1";
      executionId: string;
      agent: Extract<SoAddress, { kind: "agent" }>;
      context: SoRuntimeVisibleContext;
      message: SoMessageEnvelope;
      tools: readonly SoToolDefinition[];
      state?: JsonObject;
      options?: { maxSteps?: number; maxToolCalls?: number; timeoutMs?: number };
      metadata?: JsonObject;
    },
    signal: AbortSignal,
  ): Promise<{
    next(input: SoTurnInput, signal: AbortSignal): Promise<SoTurnDecision>;
    close?(outcome: SoExecutionStatus, signal: AbortSignal): void | Promise<void>;
  }>;
}
type SoAuditEvent = {
  version: "1";
  type: string;
  outcome: string;
  at: string;
  traceId: string;
  namespaceId: string;
  actor: SoAddress;
  authority: SoAddress;
  owner: SoAddress;
  purpose: string;
  resource?: { namespace: string; path: string[]; owner?: SoAddress };
  action?: string;
  grantId?: string;
  authorityHash?: string;
  operationId?: string;
  tool?: string;
  messageId?: string;
  receiver?: SoAddress;
  reason?: string;
  metadata?: JsonObject;
};

type SoMessageDeliveryResult =
  | { status: "accepted" | "delivered"; messageId: string; timestamp: string; metadata?: JsonObject }
  | { status: "denied" | "failed"; messageId: string; timestamp: string; error: SoProtocolError; metadata?: JsonObject };
type SoResourceOperation = {
  operationId: string;
  context: SoAccessContext;
  resource: { namespace: string; path: string[]; owner?: SoAddress };
  action: string;
  input?: JsonValue;
  metadata?: JsonObject;
};
type SoResourceResult =
  | { status: "succeeded"; operationId: string; output: JsonValue; completedAt: string; metadata?: JsonObject }
  | { status: "denied" | "failed"; operationId: string; error: SoProtocolError; completedAt: string; metadata?: JsonObject };
type SoExecutionEvent = {
  version: "1";
  eventId: string;
  executionId: string;
  traceId: string;
  sequence: number;
  type: string;
  data: JsonValue;
  occurredAt: string;
};
type SoExecutionResult =
  | { status: "succeeded"; executionId: string; traceId: string; output: JsonValue; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string }
  | { status: "denied" | "failed"; executionId: string; traceId: string; error: SoProtocolError; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string }
  | { status: "cancelled"; executionId: string; traceId: string; error?: SoProtocolError; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string }
  | { status: "escalated"; executionId: string; traceId: string; escalation: JsonObject; events: readonly SoExecutionEvent[]; startedAt: string; completedAt: string };

type OpenAICompatibleFileTurnDriverV1Options = Readonly<{
  model: PactModelConfigV1;
  requestedModel?: string;
  fetch?: typeof globalThis.fetch;
  environment?: Record<string, string | undefined>;
}>;
```

`SharedOsModulesV1.contracts` exposes the strict access, capability-grant,
execution-request, message-envelope, tool-call, and tool-result schemas;
`.core` exposes `SharedOSKernel`, `CapabilityAuthorizer`,
`RecipientScopedMessageCapabilityResolver`, `agentExecutionCapability`, and
`messageSendCapability`, plus the canonical
`MESSAGE_REQUEST_TOOL_DEFINITION`; `.os` exposes `createFileTools`; `.runtime` exposes
`StandardRuntime` and `SharedOSExecutor`. Constructor/method shapes mirror only
the calls made by `sharedos-file-session.ts`; no index signature hides missing
exports, and the loader rejects any absent member before a run starts.

Concretely, the structural module shape requires schema objects with `parse`, a
kernel constructor accepting `grantSource`, optional authorizer, resource/tool
registries, message transport/router/resolver, trusted message-ID factory and
audit sink; kernel methods `registerResourceProvider`, `registerTool`, and
`sendMessage`; a `StandardRuntime(driver)` constructor; and a
`SharedOSExecutor(kernel,runtime,options).execute(request,options)` method. The
runtime result is the strict SharedOS execution union, including the five
`SoExecutionStatus` values above. The loader test removes each required export
in turn and proves pre-spend failure.

`sharedos-file-session-contracts.ts` defines:

```ts
export type SharedOsFileTurnResultV1 = Readonly<{
  executionId: string;
  traceId: string;
  executionStatus: "succeeded" | "denied" | "failed" | "cancelled" | "escalated";
  decision: FileTurnDecisionV1 | null;
  requesterReads: readonly FileReadReceiptV1[];
  contact?: Readonly<{
    taskId: string;
    requestMessageId: string;
    replyMessageId?: string;
    responderExecutionId?: string;
    status: "completed" | "denied" | "failed" | "cancelled";
    response?: string;
    responderReads: readonly FileReadReceiptV1[];
    providerUsage: FileProviderTelemetryV1;
  }>;
  providerUsage: FileProviderTelemetryV1;
  audit: { firstSequence: number; lastSequence: number; sha256: string };
}>;

export type CreateSharedOsFileSessionV1Options = Readonly<{
  runId: string;
  sessionIndex: number;
  maxTicks: number;
  maxToolCalls: number;
  deadlineMs: number;
  requester: { actorId: string; workspace: FileWorkspacePortV1 };
  responder: { actorId: string; workspace: FileWorkspacePortV1 };
  tasks: readonly LoadedPactPairTaskV1[];
  pactWorkspace: PactPairWorkspaceV1;
  storeRoot: string;
  createDriver(input: {
    actorId: string;
    role: "requester" | "responder";
  }): SoTurnDriver & FileProviderTelemetrySourceV1;
}>;

export interface SharedOsFileSessionV1 {
  runRequesterTurn(input: {
    tick: number;
    eventId: string;
    traceId: string;
    signal?: AbortSignal;
  }): Promise<SharedOsFileTurnResultV1>;
  close(): Promise<void>;
}

export type SharedOsFileSessionFactoryV1 = (
  input: CreateSharedOsFileSessionV1Options,
) => Promise<SharedOsFileSessionV1>;
```

The file scheduler accepts only this factory. Multi creates one session;
single creates one isolated session per task. Tests inject a fake session, not
a fake harness, contact port, kernel, workspace authorizer, or local tool loop.

**Delete completely in this task:**

- `src/suites/pact-pair/legacy-transcript/`,
  `dataset/pact-pair/legacy-transcript/`,
  `tests/suites/pact-pair/{legacy-artifacts,legacy-engine,legacy-model-requester,legacy-provider-safety,legacy-requester-driver,legacy-responder-session,legacy-runner,legacy-transcript-assets,legacy-transcript-config,legacy-world}.test.ts`, and
  `tests/runner-v1/legacy-multi-dispatch.test.ts`.
- Old runner modules `src/runner/v1/{cli,config,runner,diagnostics,model-adapter,scripted-harness,artifacts,watch-runs,evaluator,prompt,task-loader,tools,workspace}.ts`,
  `src/schemas.ts`, and their tests including
  `tests/runner-v1/{config,diagnostics,model-adapter,watch-runs,dataset-dispatch,pr31-historical-evidence,prerequisite-skips}.test.ts`.
- Local file bypass modules
  `src/runner/v1/{contact-agent,file-harness,file-model-adapter}.ts` and
  `tests/runner-v1/{contact-agent,file-harness,file-model-adapter}.test.ts`.
- Old Pair execution modules
  `src/suites/pact-pair/{runner,environment,resume,rescore,sharedos-execution,harbor,prompt}.ts`
  and `tests/suites/pact-pair/{runner,resume,rescore,prompt}.test.ts`.
- Old embedded modules
  `src/execution/sharedos/v1/{adapter,mock-adapter,embedded-adapter,embedded-types}.ts`
  and `tests/execution/{sharedos-contracts,sharedos-conformance,sharedos-embedded,sharedos-event-ordering,sharedos-mock-adapter,sharedos-runner-wiring}.test.ts`.
- Old Net execution modules
  `src/suites/pact-net/{runner,environment,model-harness,scripted-harness,sharedos-execution,harbor,prompt,tools}.ts`
  and `tests/suites/pact-net/{runner,model-harness,sharedos-execution,sharedos-preflight,harbor-execution}.test.ts`.
- `src/runner/v1/backends/`, `src/runner/v1/container-entrypoint.ts`, `harbor/`,
  `tsconfig.harbor.json`, `tests/golden/`,
  `tests/runner-v1/{concurrency,container-entrypoint,harbor-backend,harbor-net-package,harbor-task-package}.test.ts`,
  and `examples/{pact-run.azure-local-sharedos,pact-run.azure-local,pact-run.harbor-net-smoke,pact-run.harbor-sharedos-smoke,pact-run.harbor-smoke,pact-run.harbor-split-01,pact-run.openai-compatible,pact-run.openrouter}.yaml`.
- `src/adapter-host/`, `src/submission/`, `examples/submissions/`,
  `tests/protocol-v1/`, and then the complete `src/protocol/v1/` after its small
  JSON/task contracts move to `src/contracts/`.
- `rebuttal/` and every top-level script except `scripts/README.md` and
  `scripts/huggingface/`. Rewrite `scripts/README.md` to document only the
  retained exporter.
- Unreferenced historical dataset assets:
  `dataset/pact-pair/tasks/{gold_answers_legacy.json,gold_answers_legacy.md}`,
  `dataset/pact-pair/splits/10_splits/`,
  `dataset/pact-pair/heartbeat_experiment.md`,
  `dataset/pact-pair/data_spec/{seed_research_db.ts,seed_pact_pair.ts,alex_data_manifest.json}`,
  every `COO.md` and
  `USER.md` under `dataset/pact-pair/agent_configs/`, Alex's four
  `RELATIONSHIP_*.md` files, and `tina/tina_policy.md`. Retain only the
  registered four-file actor workspaces and canonical
  `alex_data_store.json`; update `dataset/pact-pair/BENCHMARK_DATA.md` to name
  only those canonical assets.
- Stale public docs `docs/submission_format.md`,
  `docs/sharedos-execution-adapter.md`,
  `docs/sharedos-runner-follow-ups.md`, and
  `docs/openrouter-benchmark.md`. Remove dead rebuttal/submission/legacy
  sections from `.gitignore`, README, `docs/running.md`,
  `docs/architecture.md`, and `docs/datasets.md`; Task 5 writes the final
  product-facing narrative.
- `.dockerignore`, after both Docker execution surfaces above are gone.
- Superseded legacy design records
  `docs/superpowers/plans/2026-08-25-legacy-multi-transcript-successor.md` and
  `docs/superpowers/specs/2026-08-25-legacy-multi-transcript-successor.md`.

Remove the deleted CLI, sample submission, benchmark, rescore/watch, Harbor,
and golden scripts/jobs from `package.json` and CI. Retain dataset validation,
Pair/Net smoke validation, evaluation tools, and Hugging Face export. Temporarily
make `test:sharedos` run only the new pinned loader test until Task 3 adds real
runtime conformance.

**TDD and gates:**

1. Add REDs for extracted contracts/model behavior and fake-session scheduling.
2. Add pre-spend REDs rejecting `--legacy`, `pact-run/v1`, `pact-net`, backend
   selection, runtime budgets over 600 seconds, and omitted mode during the
   migration. Only explicit `multi`/`single` may reach the not-yet-wired session
   seam; Task 5 is the sole commit that enables the no-mode default. Reject
   `maxToolCalls < 6` and set the default to 8.
3. Implement the pure OpenAI-compatible turn driver. It sees only
   SharedOS-supplied tools, returns calls to SharedOS, and consumes only
   SharedOS tool results. It has no workspace, handler, grant, evaluator,
   contact, or transport property. Before a provider request it projects each
   internal SharedOS tool to exactly provider-safe name, description, and input
   schema; `requiredCapability`, resource owner/path, authority context, grants,
   and internal annotations never leave the host.
4. Refactor retained file scheduler/artifact/ledger imports to the new owners;
   refactor Pair tools into task-scoped raw data operations without an access
   plan. Then delete the exact surface above.
5. Rewrite the loader for the pinned four packages and digest.
6. Run focused tests, `npm run type-check`, `npm run validate`, Hugging Face
   600-row export, and the full remaining test suite.
7. Scan production source, config, CI, scripts, examples, and dataset registry
   for deleted execution symbols/paths. ADRs and the negative `--legacy` test
   may explain the retirement; no executable path may reference it.

Commit: `refactor(runner): remove competing execution substrates`.

### Task 2: Add one durable session store and actor-owned file provider

**Create:**

- `src/runner/v1/sharedos-session-store.ts`
- `src/runner/v1/sharedos-file-provider.ts`
- matching focused tests.

`SharedOsSessionStoreV1` implements SharedOS `GrantSource`,
`GrantUsageStore`, `AuditSink`, and `MessageTransport`. One run directory owns
immutable `binding.json` and `grants.json`, plus digest-chained grant usage,
messages, and metadata-only audit records. Identical stable IDs replay;
conflicting content fails closed. It has no authorization method.
`openSharedOsSessionStoreV1({runDirectory,binding,grants})` requires the
immutable binding to enumerate `responderGrantSets:[{taskId,grantIds}]`.
`GrantSource.load` returns only exact namespace/actor/issuer grants, and only
the responder set durably bound to the current trace. Its transport accepts at
most one request envelope (`replyTo` absent) for a trace/heartbeat; replies are
not counted by that rule. A later authorized request returns a fixed
failed-delivery receipt without a second append. Optional message provenance is
preserved but never treated as authority. A durable close marker makes all
future grant loads return an empty set while the host evidence readers remain
available.

Its host-only, non-authorizing read surface is:

```ts
interface SharedOsSessionStoreV1 {
  readMessage(messageId: string): Promise<SoMessageEnvelope | null>;
  bindResponderGrantSet(input: {
    traceId: string;
    requestMessageId: string;
    taskId: string;
    grantIds: readonly string[];
  }): Promise<void>;
  snapshotAudit(): Promise<{ nextSequence: number }>;
  readAuditWindow(input: {
    fromSequence: number;
    toSequenceExclusive: number;
  }): Promise<readonly SoAuditEvent[]>;
  close(): Promise<void>;
}
```

The file provider implements SharedOS `ResourceProvider` for `files`. It routes
by trusted actor, maps only `[actorId, filename]`, rejects list/traversal/foreign
actors/special files, supports exact reads and versioned `MEMORY.md` replace,
and permits at most one successful MEMORY publication per actor turn. Its
host-only evidence query returns actor+trace receipts and it has `close()`.
Those receipts are heartbeat-local evidence, not a second recovery database;
Task 4 commits accepted receipts into the existing heartbeat ledger.

The version codec is one canonical decimal string. `encodeFileVersionV1(n)` is
`String(n)` for a nonnegative safe integer. `decodeFileVersionV1(value)` accepts
only `/^(0|[1-9][0-9]*)$/`, requires a safe integer, and round-trips to the same
string; whitespace, signs, decimals, exponent notation, and leading zeros fail
before any workspace call. `files.read` and successful/conflicting
`files.replace` results project the workspace's numeric version through this
codec, while `files.replace.expectedVersion` is decoded before
`FileWorkspacePortV1.replaceMemory`.

The exact provider projection is:

```ts
// files.read
{ content, version: encodeFileVersionV1(n), sha256, byteLength }

// files.replace (a CAS conflict is a successful domain result)
{
  outcome: "committed" | "conflict",
  version: encodeFileVersionV1(n),
  sha256,
  byteLength,
  durability?: "published_unsynced",
}
```

The generic SharedOS catalogue leaves `expectedVersion` optional, so this
provider rejects omission before workspace work. SharedOS itself preserves the
opaque token without trimming; the provider then applies the stricter decimal
codec above.

**TDD and gates:**

1. RED: exact context-scoped grant lookup, immutable manifest, cross-process
   atomic usage, restart, replay/conflict, message/audit durability and privacy,
   one-request-per-trace delivery, closed-session zero authority, fencing,
   symlink/special-file denial, and malformed-record fail-loud.
2. RED: responder task grants appear only after the immutable accepted request
   ID/trace/task binding; payload task IDs cannot activate them.
3. RED: both actors' exact four-file behavior, foreign/path denial with zero
   workspace work, read-before-replace, expected-version CAS, one success per
   turn, post-CAS reads, cancellation, exact receipts, and every accepted or
   rejected version-codec boundary.
4. Implement only the four existing SharedOS host ports and one actor-owned
   provider. Do not add a second workspace or policy engine.
5. Run focused tests and type checking.

Commits: `feat(runner): add SharedOS file provider` and
`feat(runner): add SharedOS session store`.

### Task 3: Build the authorized request/reply session

**Create:**

- `src/runner/v1/sharedos-file-session.ts`
- `src/runner/v1/sharedos-message-router.ts`
- `src/suites/pact-pair/sharedos-grants.ts`
- `src/suites/pact-pair/sharedos-tools.ts`
- focused session/router/grant/tool tests
- `tests/execution/sharedos-runtime-conformance.test.ts`.

The request payload is exactly `{taskId,message}`. Successful responder output
is only `completed`, `denied`, or `cancelled`; there is no model-authored
`failed` decision. The host copies `taskId` from the accepted request into the
reply. Executor `denied`, `failed`, `cancelled`, or `escalated` emits no reply;
all except cancellation map to sanitized contact `failed`, while cancellation
maps to contact `cancelled`.

The session factory constructs one logical run namespace, the exact immutable
grant manifest above, SharedOS kernel/authorizer/runtime, canonical files tools,
and per-task PACT handlers. Kernel objects may be recreated; the namespace and
host stores are durable. The model driver is created separately for each actor
turn.

The seven-step message flow is:

1. requester invokes canonical `messages.request` with recipient and payload;
2. SharedOS constructs trusted sender/purpose/trace/message ID;
3. SharedOS authorizes and consumes the recipient-scoped send grant once;
4. the store durably appends the accepted request;
5. the router re-reads that request, binds the selected task grants, and runs
   the recipient as a new SharedOS turn;
6. the responder reply is separately authorized and appended with `replyTo`;
7. the router re-reads and validates the durable reply before resolving the
   original tool call.

**TDD and gates:**

1. RED the full allow/deny matrix for both execution grants, exact catalogues,
   cross-actor files, task tools, argument-derived requirements, send/reply
   consumption, denied zero-work, recipient-owned execution, forged payload,
   correlation, cancellation, timeout, and audit.
2. RED the exact grant manifest tuples, numeric `maxUses`, PACT capability
   matrix, accepted-trace activation, and notes/todos non-discovery.
3. RED that the driver input contains only the exact SharedOS-filtered
   `request.tools`, and that neither driver options nor driver/session objects
   expose a local/direct tool channel. Prove its outbound provider tool JSON is
   exactly `{name,description,parameters:inputSchema}` and contains no
   `requiredCapability`, resource, owner, authority, grants, or context. The
   immutable run binding records `toolSurface:"sharedos-runtime"`; no MCP
   endpoint or `ToolPolicy` is claimed.
4. RED that responder discovery/request ceilings omit the `messages` namespace
   and canonical request tool. A forged responder `messages.request` call is
   unavailable before kernel transport; the trusted host reply still succeeds
   through `kernel.sendMessage`, consumes exactly one reply grant, and carries
   `replyTo`.
5. RED that one requester execution may route at most one accepted request;
   `SharedOsSessionStoreV1.deliver` is necessarily invoked after SharedOS has
   authorized and consumed the second send attempt, but returns a stable failed
   delivery with zero durable append, recipient/model/handler work, or reply.
6. RED durable first-authoritative-contact per task across heartbeats. After a
   later request is durably appended, the router's atomic task binding detects
   an existing authority and returns a sanitized failed resolution with zero
   responder execution, handler, or reply; the original request/task binding
   remains immutable.
7. RED four-file evidence gates through SharedOS. An accepted request may be
   logged, but the router performs zero recipient work unless requester receipts
   for the same actor and trace cover AGENT, HEARTBEAT, POLICY, and MEMORY. A
   responder `completed` or `denied` decision emits no reply unless its own
   same-turn receipts cover the same four files; the contact becomes sanitized
   `failed`. These are benchmark evidence preconditions, not authorization.
8. Implement the run-scoped router/session and raw PACT task view. No queue,
   inbox product, wake-up service, dynamic delegation, or second authorizer.
9. Run focused tests, type checking, and pinned-real-build conformance with
   `PACT_REQUIRE_SHAREDOS=1`. Missing or mismatched SharedOS is failure, not
   skip. Redefine `test:sharedos` to this conformance surface.

Commit: `feat(runner): execute file sessions through SharedOS`.

### Task 4: Put scheduling and evidence behind one heartbeat boundary

**Create/modify:**

- create `src/runner/v1/file-workflow-recovery.ts`
- modify file workflow ledger/artifacts, Pair file scheduler, multi/single
  wrappers, runner facade, and their focused tests.

```ts
runFileWorkflowHeartbeatV1({
  ledger,
  identity: { tick, eventId: heartbeatId, traceId, inputDigest },
  execute,
})
```

The function publishes a durable start before calling the real
`SharedOsFileSessionV1`. Matching completed records replay without execution.
Matching starts without completion return `indeterminate_external_operation`
without execution. Identity mismatch, general corruption, and storage failure
remain fail-loud. This is conservative at-most-once retry behavior, not a claim
of exactly-once remote execution.

**TDD and gates:**

1. RED completed replay, every start/execute/commit crash window, identity
   conflict, finalized replay, marker-only sanitization, ordinary corruption
   fail-loud, concurrent writer fencing, and close ordering.
2. RED scheduler invariants with the real session interface: multi opens one
   session; single opens one isolated session per task; every heartbeat uses
   canonical event/trace IDs; terminal MEMORY, action snapshots, evaluation,
   containment, and ordering remain unchanged.
3. Update artifacts: no `intent`, no task-as-purpose. Bind task payload to
   accepted request and reply; include private SharedOS revision/digest,
   namespace/grant digest, execution/message IDs, audit windows, and workspace
   versions. Public artifacts contain only sanitized provenance.
4. Wire the real session factory behind the already-exclusive scheduler seam.
5. Run all recovery/ledger/artifact/multi/single tests, type checking, and
   validation.

Commit: `feat(pact-pair): schedule SharedOS heartbeats`.

### Task 5: Ship explicit modes, then switch the default

**Modify/create:**

- CLI/config/runner/workflow/registry exports
- registered requester/responder workspace assets and their hashes
- `tests/runner-v1/sharedeval-dispatch.test.ts`
- `tests/execution/sharedos-file-e2e.test.ts`
- README, running guide, architecture, ADR 0001, and a concise
  `CONTRIBUTING.md` that makes simplicity enforceable: one authority per
  concern, one production path, and every file must have a clear owner,
  consumer, and deletion condition.
- update retained dataset, metrics, and leaderboard docs so none links to the
  removed submission/Harbor/protocol surfaces.

**Ordered release gate:**

1. Write command REDs for explicit `sharedeval multi` and
   `sharedeval single`. Contradictory mode/config, `--legacy`, old protocols,
   `pact-net`, backend selection, and overlong runtime fail before spend.
2. Wire only the two explicit modes. Rewrite registered instructions to use
   canonical `messages.request({recipient,payload:{taskId,message}})` and
   `files.*`; regenerate exact asset hashes.
3. Run pinned-real-build command E2E for explicit multi and single to GREEN.
   Cover requester/responder admission, file and PACT tool allow/deny, durable
   request/reply, exact grant consumption, audit causality, replay,
   indeterminate pending heartbeat, and single-session isolation.
4. Only after step 3 is GREEN, make no-mode `sharedeval` select multi.
5. Run a distinct no-mode dispatch and end-to-end test to GREEN.
6. Run `test:sharedos`, full tests, type checking, validation, Pair and Net data
   smoke, Hugging Face export, and repository-wide diff/status checks.
7. Scan the whole repository for local/legacy/testkit execution symbols and
   paths, `intent`, old package names, rebuttal assets, submission runtimes, and
   stale links. ADRs and negative rejection tests may use the English word
   “legacy”; no executable/config/data path may remain.
8. Delete the now-executed internal `docs/superpowers/` plans/specs; the ADRs,
   public architecture, and Git history are the durable record.
9. Obtain independent security and simplicity reviews before declaring the
   default switch complete.

Commit: `feat(runner): make SharedOS workflows the only runtime`.

## Completion boundary

This plan ends with a clean, verified local branch containing one execution
substrate and two public workflow semantics. Remote delivery, repository rename
and transfer to `Aicoo-Team/SharedEval`, and remote branch retention are a
separate explicitly authorized release step after this branch is reviewed.
