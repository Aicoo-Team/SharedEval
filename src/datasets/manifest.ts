import { Buffer } from 'node:buffer';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import type { EvaluationSpec } from '../evaluation/index.js';

export const DATASET_MANIFEST_API_VERSION_V1 = 'pact-bench/dataset/v1' as const;
export const PACT_DATASET_MANIFEST_API_VERSION_V1 = DATASET_MANIFEST_API_VERSION_V1;
export const DATASET_MANIFEST_API_VERSION = DATASET_MANIFEST_API_VERSION_V1;
export const MAX_DATASET_MANIFEST_BYTES_V1 = 64 * 1024;

const reservedNames = new Set(['__proto__', 'constructor', 'prototype']);

export const datasetIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'must be a lowercase identifier',
  )
  .refine(value => !reservedNames.has(value), 'reserved names are not allowed');

export const datasetMetricNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/,
    'must be a metric identifier',
  )
  .refine(value => !reservedNames.has(value), 'reserved names are not allowed');

export const datasetSemanticVersionSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    'must be a semantic version',
  );

export const datasetProtocolSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/,
    'must be a versioned protocol identifier',
  );

export const datasetSafeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(value => !value.includes('\0'), 'NUL is not allowed')
  .refine(value => !value.startsWith('/'), 'path must be relative')
  .refine(value => !/^[A-Za-z]:/.test(value), 'path must be relative')
  .refine(value => !value.includes('\\'), 'use POSIX path separators')
  .refine(
    value => /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value),
    'path contains unsupported characters',
  )
  .refine(
    value => value.split('/').every(segment => segment !== '.' && segment !== '..'),
    'dot path segments are not allowed',
  );

const datasetAssetsSchema = z
  .record(datasetIdentifierSchema, datasetSafeRelativePathSchema)
  .superRefine((assets, context) => {
    const count = Object.keys(assets).length;
    if (count < 1 || count > 64) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assets must contain between 1 and 64 named paths',
      });
    }
  });

export const datasetEvaluatorReferenceSchema = z
  .object({
    id: datasetIdentifierSchema,
    version: datasetSemanticVersionSchema,
  })
  .strict();

export const datasetEvaluationSpecSchema = z
  .object({
    evaluator: datasetEvaluatorReferenceSchema,
    metrics: z
      .array(datasetMetricNameSchema)
      .min(1)
      .max(128)
      .refine(metrics => new Set(metrics).size === metrics.length, {
        message: 'metric names must be unique',
      }),
  })
  .strict();

export const datasetManifestV1Schema = z
  .object({
    apiVersion: z.literal(DATASET_MANIFEST_API_VERSION_V1),
    kind: z.literal('Dataset'),
    id: datasetIdentifierSchema,
    name: z.string().trim().min(1).max(100),
    version: datasetSemanticVersionSchema,
    protocol: datasetProtocolSchema,
    assets: datasetAssetsSchema,
    evaluation: datasetEvaluationSpecSchema,
  })
  .strict();

export const datasetManifestSchema = datasetManifestV1Schema;

export type DatasetManifestV1 = z.infer<typeof datasetManifestV1Schema>;
export type DatasetManifest = DatasetManifestV1;

/** A parsed manifest plus compile-time input and evaluator-detail types. */
export type DatasetDefinition<TInput = unknown, TDetails = unknown> = Omit<
  DatasetManifestV1,
  'evaluation'
> & {
  readonly evaluation: EvaluationSpec<TInput, TDetails>;
};

export function parseDatasetManifestV1(value: unknown): DatasetManifestV1 {
  return datasetManifestV1Schema.parse(value);
}

export const parseDatasetManifest = parseDatasetManifestV1;

export function defineDataset<TInput = unknown, TDetails = unknown>(
  value: unknown,
): DatasetDefinition<TInput, TDetails> {
  return parseDatasetManifestV1(value) as DatasetDefinition<TInput, TDetails>;
}

export function parseDatasetManifestYamlV1(source: string): DatasetManifestV1 {
  if (Buffer.byteLength(source, 'utf8') > MAX_DATASET_MANIFEST_BYTES_V1) {
    throw new Error(`dataset manifest exceeds ${MAX_DATASET_MANIFEST_BYTES_V1} bytes`);
  }

  const documents = parseAllDocuments(source, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throw new Error('dataset manifest must contain exactly one YAML document');
  }

  const [document] = documents;
  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    const message = document?.errors[0]?.message
      ?? document?.warnings[0]?.message
      ?? 'invalid YAML';
    throw new Error(`dataset manifest YAML is invalid: ${message}`);
  }

  const value = document.toJS({ maxAliasCount: 0 });
  return parseDatasetManifestV1(value);
}

export const parseDatasetManifestYaml = parseDatasetManifestYamlV1;
