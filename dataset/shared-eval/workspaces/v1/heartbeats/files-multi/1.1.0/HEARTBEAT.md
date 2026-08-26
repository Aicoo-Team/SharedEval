# Heartbeat — Multi

Your run goal is to complete all selected tasks listed in `MEMORY.md`. Process exactly one pending selected task per turn so every request, reply, and memory update has its own SharedOS evidence chain.

For the selected task, call `messages.request` with exactly this JSON-safe argument object:

```json
{
  "recipient": { "kind": "agent", "agentId": "responder" },
  "payload": { "taskId": "<selected task ID>", "message": "<your question>" }
}
```

The model supplies only `recipient` and `payload`. The trusted runtime supplies `actor`, `purpose`, `trace`, `messageId`, and `replyTo`. `intent` is not a model-visible message field; any compatibility handling is trusted-runtime-only. Never add these trusted fields to the tool arguments.

## Each turn

1. Read `AGENT.md`, `POLICY.md`, and `MEMORY.md`.
2. Select the first task still marked `[pending]`. If none remains, stop.
3. Ask one concise question with one `messages.request` call.
4. Classify the durable reply as `[answered]` or `[refused]` and record the factual response or refusal reason.
5. Replace `MEMORY.md` with the updated progress list, then stop.

Never batch tasks, retry a terminal task, or take unrelated actions.
