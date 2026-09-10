# Bounded PAIR Multi Probe

This is a new persistent-world experiment, not a resume of the audited run.
The model and provider identifiers below come from that run; configuration
validation does not establish their current availability. No paid provider
request was made while validating this example.

The probe selects two questions, a fixed requester/responder pair, eight ticks,
and the existing two-phase retry strategy. Both actors retain their own full
conversation across ticks and tasks. Each turn still reads the four current
files. A history-budget failure stops the world rather than resetting it.

```yaml
apiVersion: sharedeval-run/v2
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://openrouter.ai/api/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: deepseek/deepseek-v4-flash-0731
  temperature: 0
  providerRouting:
    requireParameters: true
    allowFallbacks: false
    only: [Inceptron]
  maxOutputTokens: 4096
benchmark:
  dataset: pact-pair
  policy: D2
  requester: R1
  gradingMode: category
  tasks:
    kind: qa
    ids: [PAIR-Q1, PAIR-Q106]
workflow:
  mode: multi
  protocol: files
  maxTicks: 8
  stopWhen: all-terminal
  world:
    protocol: actor-context/v1
    maxContextBytes: 1048576
  multiTurn:
    phase2StartTick: 3
    finalizeTick: 8
budget:
  maxToolCalls: 12
  maxRuntimeMs: 300000
output:
  directory: runs
  saveTraces: true
```

After extracting the YAML into a local configuration, run `--check` first and
choose a new run ID. Use the pinned runtime and credential alias documented in
[Running SharedEval](running.md). Raw conversation journals and traces contain
private benchmark interactions; do not publish them as public result artifacts.

## Acceptance Evidence

A live probe should establish all of the following before launching a grid:

- Both actors' second model inputs contain their own previous contact history.
- Requester-private deliberation does not appear in the responder's history.
- Current-turn file reads and authorized tool discovery still occur.
- A changed retry follows an observed response, rather than a fresh context.
- Each completed tick commits matching before/after journal frontiers.
- Provider errors and incomplete tool work remain explicit incomplete execution,
  not privacy failures or scored zeroes.

Scripted native-runtime conformance tests cover continuity, isolation, file
reads, tool authorization, and malformed MEMORY write attempts without external
model calls. They do not demonstrate DeepSeek availability, effective adaptive
attacks, or benchmark accuracy.
