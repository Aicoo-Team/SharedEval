# Native NET commands

`sharedeval net check|run|score` provides a versioned entry point for the existing
scripted procurement adapters. It supports registered P-01, one assigned case,
and a bounded procurement world. General NET task selection and model providers
are outside this configuration. PACT-Pair keeps its existing `multi`/`single`
commands and `sharedeval-run/v1|v2` formats.

## Check, run and score

Use Node 24 and `npm ci`. Run commands below from the repository root.

```sh
npm run sharedeval -- net check --config docs/configs/net-p01-success-v1.yaml

# Set this to a built SharedOS checkout or bundle at the verified repository pin.
export SHAREDEVAL_SHAREDOS_DIR=/absolute/path/to/pinned-SharedOS
npm run sharedeval -- net run --config docs/configs/net-p01-success-v1.yaml --max-turns 2
npm run sharedeval -- net run --config docs/configs/net-p01-success-v1.yaml

# Python 3 is required only for the explicit post-hoc scoring command.
npm run sharedeval -- net score --config docs/configs/net-p01-success-v1.yaml
```

`check` parses the configuration, validates its materialized profile, and prints
case/actor identities, digests, scoring registration and the required runtime
pin. It creates no run artifacts and calls neither SharedOS nor a model. `run`
verifies the actual SharedOS build before creating output. Its only provider is
`scripted-procurement/v1`; no model credential or API call is involved.

`--max-turns` is a per-invocation limit from 0 to 1000, defaulting to 40. It is
accepted only by `run`. Zero opens or resumes a checkpoint without an actor turn;
it can create command/native artifacts. A later invocation with the same config
and directory continues from a committed boundary. A successful command can
still have pending deliveries or a held domain result: inspect the printed
`terminalSuccess`, `worldComplete` and `pendingDeliveries` fields.

## Configuration and examples

Configurations are strict JSON or YAML documents. Relative `outputDirectory`
and `execution.profileFile` paths resolve from the configuration file's directory.

```yaml
version: pact-net-native-run/v1
runId: p01-demo
outputDirectory: ../../runs/p01-demo
provider:
  type: scripted-procurement/v1
execution:
  kind: p01-pilot
  mode: success
```

| Example in `docs/configs/` | Execution | Scoring |
| --- | --- | --- |
| [net-p01-success-v1.yaml](configs/net-p01-success-v1.yaml) | Original P-01, `success` | Registered P-01 |
| [net-p01-safe-partial-v1.yaml](configs/net-p01-safe-partial-v1.yaml) | Original P-01, `safe-partial` | Registered P-01 |
| [net-assigned-v1.yaml](configs/net-assigned-v1.yaml) | `assigned-pilot` with `profileFile` | Unregistered |
| [net-world-multi-v1.yaml](configs/net-world-multi-v1.yaml) | `procurement-world`, profile mode `multi` | Unregistered |
| [net-world-single-v1.yaml](configs/net-world-single-v1.yaml) | `procurement-world`, profile mode `single` | Unregistered |

Use any example with `net check` and `net run`. The assigned and world examples
reference the repository's synthetic fixtures. World mode, order, actor contexts
and public disclosure are declared in the world profile; there is no independent
CLI mode override. The emitted workflow ID is `net-multi` for a Multi world and
`net-single` for the other adapters. This label does not reset the persistent
actor history between turns within a one-case pilot.

Unknown keys, extra flags, general task selectors and other provider types are
rejected. These examples exercise native integration; they do not register new
benchmark cases or report model benchmark results.

## Artifacts, identity and ownership

An output directory belongs to one bound run. `run-manifest.json` records the
command contract, run ID, provider, adapter kind, profile digest and verified
SharedOS pin. `checkpoint.json` and actor context journals remain the native
adapter's durable state. `execution.json` wraps a committed native snapshot with
its configuration, checkpoint and evidence digests. The unified command does
not emit the legacy script's standalone `evidence.json`.

Configuration identity includes the version, run ID, provider, adapter kind,
materialized profile and required SharedOS revision/runtime digest. It excludes
file locations. An intact, closed run can move together with its journals to a
new directory; update the config paths while preserving those bound values.
Changing a profile path to identical content preserves identity. Changing case
order, mode, resources, roles, public readers or context budget changes identity.

`command.lock` serializes manifest, execution-export and scoring publication.
Manifest validation/publication also holds the native `writer.lock`, then hands
ownership to the native session before any actor turn. If a direct adapter wins
that handoff race, opening the session fails closed. Scoring holds both locks while reading and
publishing, so a direct adapter cannot change the checkpoint during evaluation.
An existing lock fails closed; neither command deletes another owner's stale
lock. Missing manifests in nonempty legacy/orphaned directories are rejected.
Use legacy scripts with their own runs or start a fresh unified run; automatic
adoption is not supported.

Scoring rejects corrupt/checksum-mismatched artifacts, changed run bindings,
pending native work and an execution receipt that no longer matches the current
checkpoint. A completed direct-adapter continuation can make an earlier
`execution.json` stale; a clean unified `net run --max-turns 0` may republish it
after native reopen validation. This does not bypass pending work, corrupt
journals, mismatched bindings or stale locks. Preserve uncertain run artifacts
for investigation instead of forcing replay. Checksums assume trusted host
storage; they are not signatures against an operator who can rewrite all files.

## Registered post-hoc evaluation

Only `execution.kind: p01-pilot` can use `net score`. Assigned cases and worlds
fail with `native_net_evaluator_not_registered`, even when their domain outcome
is released. P-01 scoring requires a committed, drained, audited snapshot whose
events, authorization records, resource binding and final state agree.

The scorer is loaded only for `score`. After those checks, it sends a temporary
submission to the existing P-01 Python evaluator, validates the returned finite
score/checkpoint/safety-gate structure and removes the temporary files. Execution
does not load rubric or reference-gold material. `evaluation.json` contains the
`pact-net-evaluation/v1` wrapper, bound evidence digest, submission and result;
scoring does not resume or repeat actor turns. A later score can replace this
derived report under the same ownership checks.

See the [CLI decision](adr/2026-09-13-native-net-cli.md),
[P-01 adapter](pact-net-pilot.md), [assigned profiles](pact-net-assigned-profiles.md)
and [world lifecycle](pact-net-world.md) for the underlying contracts.
