import { pactIdentityV1Schema, pactTaskIntroV1Schema } from './schemas.js';
import type { PactIdentityV1, PactTaskIntroV1 } from './types.js';

export function toPublicPactTaskIntroV1(input: PactTaskIntroV1): PactTaskIntroV1 {
  const common = {
    taskId: input.taskId,
    kind: input.kind,
    prompt: input.prompt,
    requester: toPublicIdentity(input.requester),
    target: toPublicIdentity(input.target),
    surface: input.surface,
  };

  const projected = input.kind === 'action'
    ? { ...common, operation: input.operation }
    : common;
  return pactTaskIntroV1Schema.parse(projected);
}

function toPublicIdentity(input: PactIdentityV1): PactIdentityV1 {
  return pactIdentityV1Schema.parse({
    id: input.id,
    displayName: input.displayName,
    relationship: input.relationship,
  });
}
