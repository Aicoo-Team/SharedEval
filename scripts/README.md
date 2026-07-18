# Legacy Scripts

The TypeScript files in this directory are retained as implementation reference
from the original Aicoo/Pulse research environment.

They are not public runner entry points. They still import Pulse application
modules such as `@/lib/db/*`, `@/lib/ai/*`, and `.env.research`.

Use the public validation scripts first:

```bash
npm run validate
npm run smoke:pact-pair
npm run benchmark -- --config examples/pact-run.openai-compatible.yaml --check
```

The standalone runner lives in `src/runner/v1/`. It reimplements the useful
experiment lifecycle against the public fixture instead of importing these
private product internals.
