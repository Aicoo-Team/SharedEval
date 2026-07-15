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

To create a submission, copy this directory on a branch, edit `pact.yaml`, and
replace the logic in `src/adapter.ts`. Keep stdout reserved for one JSON-RPC
response per line; diagnostic logs belong on stderr.
