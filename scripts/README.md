# Legacy Scripts

The TypeScript files in this directory are retained as implementation reference
from the original Aicoo/Pulse research environment.

They are not yet public runner entry points. They still import Pulse application
modules such as `@/lib/db/*`, `@/lib/ai/*`, and `.env.research`.

Use the public validation scripts first:

```bash
npm run validate
npm run smoke:pact-pair
npm run smoke:pact-net
```

Future work should add a standalone runner behind the contracts in `src/`
instead of importing private product internals.
