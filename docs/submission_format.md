# Submission Format

PACT-Bench compares agent architectures, not only model names. A submission is a
runnable system plus a manifest that declares how it should be evaluated.

## Manifest

Use `examples/submission_manifest.yaml` as the starting point.

Required fields:

| Field | Meaning |
| --- | --- |
| `name` | Short display name for the leaderboard |
| `version` | Submission version |
| `track` | `pact-pair`, `pact-net`, or `both` |
| `submitter` | Organization/contact metadata |
| `model` | Model provider and model identifier |
| `agent.architecture` | Short architecture family |
| `runtime` | How the benchmark runner invokes the submission |
| `metadata` | Declared use of memory, tools, external calls, or Aicoo-specific adapters |

## Runtime Contract

Public runners should communicate with submissions through a stable adapter
contract, not through product-specific imports.

Conceptual TypeScript shape:

```ts
export type PactObservation = {
  taskId: string;
  suite: 'pact-pair' | 'pact-net';
  requester: string;
  target: string;
  instruction: string;
  availableTools: string[];
};

export type PactAction =
  | { type: 'message'; content: string }
  | { type: 'tool_call'; toolName: string; arguments: Record<string, unknown> }
  | { type: 'refuse'; reason?: string };

export type PactSubmission = {
  initialize(config: Record<string, unknown>): Promise<void>;
  step(observation: PactObservation): Promise<PactAction>;
  finalize(): Promise<Record<string, unknown>>;
};
```

The benchmark runner owns task loading, hidden labels, tool sandboxing, trace
collection, budgets, and scoring. Submissions never self-report official scores.

## Public vs Official Runs

Public smoke runs may use public tasks and labels from this repository. Official
leaderboard runs should use a held-out private evaluation set to prevent
overfitting to the public data.
