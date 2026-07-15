import { z } from 'zod';
import {
  MAX_PACT_WIRE_LINE_BYTES_V1,
  assertPactJsonComplexityV1,
} from './limits.js';
import {
  PACT_ADAPTER_PROTOCOL_VERSION_V1,
  jsonValueSchema,
  pactBoundaryPlanV1Schema,
  pactDecisionV1Schema,
  pactFinalizeReportV1Schema,
  pactObservationV1Schema,
  pactRunInitV1Schema,
  pactTaskIntroV1Schema,
} from './schemas.js';

const jsonRpcIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must be a valid JSON-RPC request id');

const initializeRequestV1Schema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: z.literal('pact.initialize'),
    params: pactRunInitV1Schema,
  })
  .strict();

const planBoundaryRequestV1Schema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: z.literal('pact.planBoundary'),
    params: z.object({ task: pactTaskIntroV1Schema }).strict(),
  })
  .strict();

const stepRequestV1Schema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: z.literal('pact.step'),
    params: z.object({ observation: pactObservationV1Schema }).strict(),
  })
  .strict();

const finalizeRequestV1Schema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: z.literal('pact.finalize'),
    params: z
      .object({
        reason: z.enum(['completed', 'aborted']),
      })
      .strict(),
  })
  .strict();

export const pactRunnerRequestV1Schema = z.discriminatedUnion('method', [
  initializeRequestV1Schema,
  planBoundaryRequestV1Schema,
  stepRequestV1Schema,
  finalizeRequestV1Schema,
]);

export const pactInitializeResultV1Schema = z
  .object({
    ready: z.literal(true),
    protocolVersion: z.literal(PACT_ADAPTER_PROTOCOL_VERSION_V1),
  })
  .strict();

export const pactPlanBoundaryResultV1Schema = z
  .object({
    plan: pactBoundaryPlanV1Schema,
  })
  .strict();

export const pactStepResultV1Schema = z
  .object({
    decision: pactDecisionV1Schema,
  })
  .strict();

export const pactFinalizeResultV1Schema = z
  .object({
    report: pactFinalizeReportV1Schema,
  })
  .strict();

const successResponseV1Schema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    result: jsonValueSchema,
  })
  .strict();

export const pactErrorResponseV1Schema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema.nullable(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1).max(4_096),
        data: jsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const pactSubmissionResponseV1Schema = z.union([
  successResponseV1Schema,
  pactErrorResponseV1Schema,
]);

export type PactAdapterMethodV1 =
  | 'pact.initialize'
  | 'pact.planBoundary'
  | 'pact.step'
  | 'pact.finalize';
export type PactRunnerRequestV1 = z.infer<typeof pactRunnerRequestV1Schema>;
export type PactSubmissionResponseV1 = z.infer<typeof pactSubmissionResponseV1Schema>;
export type PactErrorResponseV1 = z.infer<typeof pactErrorResponseV1Schema>;
export type PactInitializeResultV1 = z.infer<typeof pactInitializeResultV1Schema>;
export type PactPlanBoundaryResultV1 = z.infer<typeof pactPlanBoundaryResultV1Schema>;
export type PactStepResultV1 = z.infer<typeof pactStepResultV1Schema>;
export type PactFinalizeResultV1 = z.infer<typeof pactFinalizeResultV1Schema>;

export type PactResultByMethodV1 = {
  'pact.initialize': PactInitializeResultV1;
  'pact.planBoundary': PactPlanBoundaryResultV1;
  'pact.step': PactStepResultV1;
  'pact.finalize': PactFinalizeResultV1;
};

export type PactSuccessResponseForMethodV1<M extends PactAdapterMethodV1> = {
  jsonrpc: '2.0';
  id: string;
  result: PactResultByMethodV1[M];
};

export type PactResponseForMethodV1<M extends PactAdapterMethodV1> =
  | PactErrorResponseV1
  | PactSuccessResponseForMethodV1<M>;

const resultSchemasByMethod = {
  'pact.initialize': pactInitializeResultV1Schema,
  'pact.planBoundary': pactPlanBoundaryResultV1Schema,
  'pact.step': pactStepResultV1Schema,
  'pact.finalize': pactFinalizeResultV1Schema,
} satisfies Record<PactAdapterMethodV1, z.ZodTypeAny>;

export function parsePactRunnerRequestLineV1(line: string): PactRunnerRequestV1 {
  return pactRunnerRequestV1Schema.parse(parseJsonLine(line));
}

export function parsePactSubmissionResponseLineV1<M extends PactAdapterMethodV1>(
  line: string,
  expected: { id: string; method: M },
): PactResponseForMethodV1<M> {
  const response = pactSubmissionResponseV1Schema.parse(parseJsonLine(line));
  if (response.id !== expected.id) {
    throw new Error(
      `PACT JSON-RPC response id mismatch: expected ${expected.id}, received ${String(response.id)}`,
    );
  }
  if ('error' in response) return response;

  return {
    ...response,
    result: resultSchemasByMethod[expected.method].parse(response.result),
  } as PactResponseForMethodV1<M>;
}

export function isPactErrorResponseV1(
  response: PactSubmissionResponseV1,
): response is PactErrorResponseV1 {
  return 'error' in response;
}

export function serializePactWireMessageV1(message: unknown): string {
  assertPactJsonComplexityV1(message, 'PACT wire message');
  const json = jsonValueSchema.parse(message);
  const line = `${JSON.stringify(json)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_PACT_WIRE_LINE_BYTES_V1) {
    throw new Error(`PACT wire message exceeds ${MAX_PACT_WIRE_LINE_BYTES_V1} bytes`);
  }
  return line;
}

function parseJsonLine(line: string): unknown {
  if (Buffer.byteLength(line, 'utf8') > MAX_PACT_WIRE_LINE_BYTES_V1) {
    throw new Error(`PACT wire message exceeds ${MAX_PACT_WIRE_LINE_BYTES_V1} bytes`);
  }

  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error('PACT wire message cannot be empty');
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new Error('PACT wire message must contain exactly one JSON value');
  }

  const value = JSON.parse(trimmed) as unknown;
  assertPactJsonComplexityV1(value, 'PACT wire message');
  return value;
}
