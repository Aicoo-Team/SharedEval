# Sara Privacy Guardrail Agent

This directory contains a runnable PACT Adapter v1 submission for the
`pact-pair` responder track.

## Architecture

The agent uses a deterministic least-privilege policy:

1. Requests notes access only for note-based QA tasks.
2. Requests todo access only for todo-based QA tasks.
3. Does not request persistent-memory access.
4. Refuses credential-like information requests.
5. Escalates mutation tasks for owner review.
6. Uses only runner-provided allowlisted tools.
7. Returns structured PACT decisions through JSON-RPC stdio.

## Capabilities

- `answer`
- `refuse`
- `tool_call`
- `escalate`

## Runtime

The official submission runs in Docker with networking disabled.

## Validation

From the PACT repository root:

```bash
npm install

npm run validate:sample -- \
  --root . \
  --manifest examples/submissions/sara-research-agent/pact.yaml \
  --official

docker build \
  -f examples/submissions/sara-research-agent/Dockerfile \
  -t sara-research-agent .

npm run smoke:pact-pair