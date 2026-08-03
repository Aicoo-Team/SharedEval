# Multi-dataset architecture

PACT-Bench separates dataset assets, suite-specific runtime behavior, and
dataset-neutral evaluation infrastructure. This keeps released data auditable,
prevents a data manifest from selecting executable code, and leaves room for
additional benchmark families without making PACT-Pair the generic API.

## Layers

```text
dataset/<dataset-id>/manifest.yaml       declarative identity and asset map
dataset/<dataset-id>/**                  versioned public assets
                 │
                 ▼
src/datasets/                            manifest contract and dataset registry
                 │
                 ├──────────────┐
                 ▼              ▼
src/suites/<dataset-id>/        src/evaluation/
task loading, prompts, tools,   approved evaluators, metric validation,
workspace, evaluator, runner    and dataset-neutral aggregation
```

The boundaries are deliberate:

- `dataset/` contains data, metadata, policies, and split definitions. It does
  not contain runtime selection logic.
- `src/datasets/` validates `pact-bench/dataset/v1` manifests and indexes
  definitions by exact `id@version`.
- `src/evaluation/` defines evaluator references and metric contributions. An
  evaluator runs only when its exact `id@version` implementation is present in
  the host-owned approved registry.
- `src/suites/<dataset-id>/` owns everything that interprets a particular
  dataset: schemas, task construction, prompts, tools, workspace state, and
  scoring details.
- `src/runner/v1/` owns model transport, budgets, traces, and report lifecycle.
  Compatibility re-exports keep existing PACT-Pair imports working while new
  suite code lives under `src/suites/pact-pair/`.

## Dataset manifests

Every dataset root has a `manifest.yaml` with this strict shape:

```yaml
apiVersion: pact-bench/dataset/v1
kind: Dataset
id: pact-pair
name: PACT-Pair
version: 6.0.0
protocol: pact-bench/v1
assets:
  tasks: tasks/questions.json
  workspace: data_spec/alex_data_store.json
evaluation:
  evaluator:
    id: pact-pair
    version: 1.0.0
  metrics:
    - informationUtility
    - informationSecurity
```

Manifests are data, not plugins. Asset values are constrained relative POSIX
paths. Evaluator references are identifiers and semantic versions, never file
paths, package names, URLs, or source code. Unknown manifest fields fail
validation so a typo cannot silently change a release contract.

The manifest's metric list is also an allowlist. The generic evaluation engine
rejects undeclared evaluator output, rejects duplicate or invalid metric
contributions, and normalizes an omitted declared metric to `0 / 0`. Generic
aggregation reports a zero-denominator metric with `value: null` instead of
inventing a score.

## Selection and dispatch

Local run configs use `benchmark.dataset` as the dataset selector:

```yaml
benchmark:
  dataset: pact-pair
```

`pact-pair` remains the default, so existing configs that omit the field keep
their behavior. The current `pact-run/v1` command and protocol are intentionally
PACT-Pair-only; an unknown dataset is rejected. Supporting another dataset in
the local runner requires an explicit, reviewed suite registration and dispatch
path. Merely placing a manifest under `dataset/` must never make code executable.

The submission protocol under `src/protocol/v1/` also remains the PACT-Pair
responder contract. The generic dataset and evaluation layers do not broaden
that public protocol by implication.

## Local and hosted boundaries

The repository is the portable benchmark engine; it is not the hosted control
plane. The intended deployment split is:

- **PACT** versions dataset manifests/assets, approved suite runtimes,
  evaluation contracts, and reproducible result artifacts.
- **Aicoo** may host dataset and submission intake, permissions, run requests,
  and leaderboard presentation. Public reading can remain unauthenticated;
  creating or mutating a submission should require an Aicoo identity/API key.
- **Execution backends** run an approved suite. The current implementation is
  local TypeScript. An isolated container backend such as Harbor can be added
  behind the same runner boundary; it is not the dataset registry or scoring
  API.

No hosted intake endpoint is deployed by this repository today. Keeping that
product API in Aicoo lets authentication and abuse controls evolve without
turning the public manifest or adapter protocol into an account API.

## PACT-Pair flow

For the built-in suite, the runtime flow is:

1. Parse the run config and select `benchmark.dataset: pact-pair`.
2. Load canonical assets from `dataset/pact-pair/` and validate them with the
   PACT-Pair schemas.
3. Construct the public task view while retaining sources, gold facts, labels,
   workspace state, and evaluator state on the runner side.
4. Give the adapter only the protocol allowlist: task prompt and identity,
   effective access, tool results, and remaining budget.
5. Evaluate the terminal decision and state diff with PACT-Pair logic.
6. Aggregate declared metrics and write the local report.

This split is a privacy boundary as well as a code-organization boundary.
Canonical assets and Hugging Face validation rows are public, but the runner
still must not place gold fields or private workspace state in adapter-facing
messages.

## Stability rules

- A dataset identity is the pair `id@version`; do not silently replace one
  version's assets or evaluator semantics.
- A manifest change and the code that interprets it should be reviewed
  together, even though they live in separate layers.
- Dataset-specific conditionals belong in the suite, not in generic metric
  aggregation or registries.
- Generic registries are explicit host allowlists. They do not scan directories,
  import manifest-provided modules, or fetch remote code.
- Public validation data and hidden official tests are separate release
  surfaces. Hidden tasks, labels, traces, and evaluator state do not belong in
  `dataset/` or in derived public dataset exports.

See [Datasets](datasets.md) for the asset and extension contract and
[Hugging Face export](huggingface.md) for the derived public release layout.
