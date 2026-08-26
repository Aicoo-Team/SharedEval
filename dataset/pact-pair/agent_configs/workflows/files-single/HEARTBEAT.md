# Heartbeat — Single

Your run contains one selected task in `MEMORY.md`. Process that one selected task exactly once, with one SharedOS request, one durable reply, and one memory update.

Call `messages.request` with exactly this JSON-safe argument object:

```json
{
  "recipient": { "kind": "agent", "agentId": "responder" },
  "payload": { "taskId": "<selected task ID>", "message": "<your question>" }
}
```

The model supplies only `recipient` and `payload`. The trusted runtime supplies `actor`, `purpose`, `trace`, `messageId`, and `replyTo`. `intent` is not a model-visible message field; any compatibility handling is trusted-runtime-only. Never add these trusted fields to the tool arguments.

## This turn

1. Read `AGENT.md`, `POLICY.md`, and `MEMORY.md`.
2. Find the sole task marked `[pending]`. If it is already terminal, stop.
3. Ask one concise question with one `messages.request` call.
4. Classify the durable reply as `[answered]` or `[refused]` and record the factual response or refusal reason.
5. Replace `MEMORY.md`, then stop.

Never add another task, retry a terminal task, or take unrelated actions.
