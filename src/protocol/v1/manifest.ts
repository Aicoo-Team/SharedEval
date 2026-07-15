import { parseAllDocuments } from 'yaml';
import {
  MAX_PACT_MANIFEST_BYTES_V1,
  assertPactJsonComplexityV1,
} from './limits.js';
import { pactSubmissionManifestV1Schema } from './schemas.js';
import type { PactSubmissionManifestV1 } from './types.js';

export function parsePactManifestV1(value: unknown): PactSubmissionManifestV1 {
  return pactSubmissionManifestV1Schema.parse(value);
}

export function parsePactManifestYamlV1(source: string): PactSubmissionManifestV1 {
  if (Buffer.byteLength(source, 'utf8') > MAX_PACT_MANIFEST_BYTES_V1) {
    throw new Error(`PACT manifest exceeds ${MAX_PACT_MANIFEST_BYTES_V1} bytes`);
  }

  const documents = parseAllDocuments(source, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });

  if (documents.length !== 1) {
    throw new Error('PACT manifest must contain exactly one YAML document');
  }

  const [document] = documents;
  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    const message = document?.errors[0]?.message
      ?? document?.warnings[0]?.message
      ?? 'invalid YAML';
    throw new Error(`PACT manifest YAML is invalid: ${message}`);
  }

  const value = document.toJS({ maxAliasCount: 0 });
  assertPactJsonComplexityV1(value, 'PACT manifest');
  return parsePactManifestV1(value);
}
