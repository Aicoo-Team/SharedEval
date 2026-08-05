import type { z } from 'zod';
import type {
  pactBoundaryPlanV1Schema,
  pactBudgetRemainingV1Schema,
  pactBudgetV1Schema,
  pactCapabilityV1Schema,
  pactDecisionV1Schema,
  pactFinalizeReportV1Schema,
  pactIdentityV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  pactRuntimeV1Schema,
  pactSubmissionManifestV1Schema,
  pactTaskIntroV1Schema,
  pactToolSpecV1Schema,
} from './schemas.js';

export type { JsonObject, JsonPrimitive, JsonValue } from './schemas.js';

export type PactCapabilityV1 = z.infer<typeof pactCapabilityV1Schema>;
export type PactRuntimeV1 = z.infer<typeof pactRuntimeV1Schema>;
export type PactSubmissionManifestV1 = z.infer<typeof pactSubmissionManifestV1Schema>;
export type PactBudgetV1 = z.infer<typeof pactBudgetV1Schema>;
export type PactBudgetRemainingV1 = z.infer<typeof pactBudgetRemainingV1Schema>;
export type PactToolSpecV1 = z.infer<typeof pactToolSpecV1Schema>;
export type PactRunInitV1 = z.infer<typeof pactRunInitV1Schema>;
export type PactIdentityV1 = z.infer<typeof pactIdentityV1Schema>;
export type PactTaskIntroV1 = z.infer<typeof pactTaskIntroV1Schema>;
export type PactBoundaryPlanV1 = z.infer<typeof pactBoundaryPlanV1Schema>;
export type PactObservationV1 = z.infer<typeof pactObservationV1Schema>;
export type PactDecisionV1 = z.infer<typeof pactDecisionV1Schema>;
export type PactFinalizeReportV1 = z.infer<typeof pactFinalizeReportV1Schema>;

/**
 * Framework-agnostic lifecycle implemented by the agent harness under test.
 *
 * The former PactAdapterV1 name remains as a compatibility alias below. The
 * JSON-RPC method names and protocol version intentionally do not change.
 */
export interface PactHarnessV1 {
  initialize(init: PactRunInitV1): Promise<void>;
  planBoundary(task: PactTaskIntroV1): Promise<PactBoundaryPlanV1>;
  step(observation: PactObservationV1): Promise<PactDecisionV1>;
  finalize(): Promise<PactFinalizeReportV1>;
}

/** @deprecated Use PactHarnessV1. */
export type PactAdapterV1 = PactHarnessV1;
