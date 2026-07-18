# TypeScript Basic Submission

This directory is a runnable PACT Adapter v1 starter. It is deliberately small
and deterministic so that the transport and lifecycle are easy to inspect. It
is not intended to be a competitive privacy policy.

From the PACT repository root:

```bash
npm install
npm run validate:sample
npm run smoke:sample
docker build -f examples/submissions/typescript-basic/Dockerfile -t pact-typescript-basic .
```

The Docker build context is the repository root because this pre-publication
starter imports the protocol and host directly from `src/`. Once the protocol
is released as a package, a downloadable submission template can depend on that
package and use this directory itself as the build context.

To develop an adapter, copy this directory, edit `pact.yaml`, and replace the
logic in `src/adapter.ts`. Keep stdout reserved for one JSON-RPC response per
line; diagnostic logs belong on stderr.

See [`docs/submission_format.md`](../../../docs/submission_format.md) for the
artifact contract. This adapter manifest is separate from the BYOK local-run
configuration documented in
[`docs/running.md`](../../../docs/running.md); hosted intake is outside this
repository's contract.
