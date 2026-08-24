/**
 * Full-grid (600 task × R0–R4) relationship label loading.
 *
 * Two on-disk formats feed one normalized in-memory label set:
 *
 * - `relationship_label_matrix.json` — the canonical v1.1 file (QA-only,
 *   Q101–Q200; 99 rows after the 2026-07 audit moved Q125 to work_public).
 *   Its bytes are canonical dataset content and are never modified; the
 *   loader ingests it as a *partial* grid.
 * - `relationship_label_matrix_v2.json` — the schema-v2 file produced by the
 *   annotation workstream (QA rows P/L/B, action rows execute/refuse).
 *   Partial coverage is valid; the file is authoritative when present and
 *   the v1.1 file is then not consulted (no merge ambiguity).
 *
 * Consumers must fail loudly when a relationship-graded run selects a task
 * with no row in the loaded set. Falling back to category labels silently is
 * forbidden: a run that scored some tasks against relationship gold and
 * others against category gold would report a single number for two
 * different measurement targets.
 *
 * Label integrity rule for actions: a row may label a requester `execute`
 * only when the canonical action's `expected_verdict` is `execute`. A
 * canonically-refused action has no executable gold contract (`gold_check`
 * is `no_change`), so an `execute` label for it would be unscorable; the
 * relationship axis can only *restrict* the action surface. The task loader
 * enforces this when it has both the matrix and the canonical actions in
 * hand.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pairRelationshipLabelMatrixSchema,
  pairRelationshipLabelMatrixV2Schema,
  PAIR_RELATIONSHIP_LABEL_MATRIX_V2_SCHEMA_ID,
} from './schemas.js';

export const PACT_PAIR_REQUESTERS_V1 = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
export type PactPairRequesterIdV1 = typeof PACT_PAIR_REQUESTERS_V1[number];
export type PactPairRelationshipLabelV1 = 'L' | 'P' | 'B';
export type PactPairActionRelationshipLabelV1 = 'execute' | 'refuse';

export const PAIR_RELATIONSHIP_LABEL_MATRIX_V1_SCHEMA_ID =
  'pact-pair-relationship-labels/v1' as const;
export { PAIR_RELATIONSHIP_LABEL_MATRIX_V2_SCHEMA_ID } from './schemas.js';

export const PACT_PAIR_RELATIONSHIP_LABEL_MATRIX_V1_PATH_V1 = join(
  'dataset',
  'pact-pair',
  'relationship_labels',
  'relationship_label_matrix.json',
);
export const PACT_PAIR_RELATIONSHIP_LABEL_MATRIX_V2_PATH_V1 = join(
  'dataset',
  'pact-pair',
  'relationship_labels',
  'relationship_label_matrix_v2.json',
);

/**
 * Provenance of the label file actually loaded. Recorded in run artifacts for
 * relationship-graded runs so a scoring-relevant label change is always
 * visible in `run.json` and stale results cannot be silently reused.
 */
export type PactPairRelationshipLabelProvenanceV1 = {
  schema:
    | typeof PAIR_RELATIONSHIP_LABEL_MATRIX_V1_SCHEMA_ID
    | typeof PAIR_RELATIONSHIP_LABEL_MATRIX_V2_SCHEMA_ID;
  /** Repository-root-relative path of the loaded file. */
  file: string;
  /** SHA-256 over the raw file bytes as loaded. */
  sha256: string;
  /** The matrix's own `version` field. */
  version: string;
  qaRows: number;
  actionRows: number;
};

export type PactPairQaRelationshipLabelRowV1 = {
  id: number;
  category: string;
  question: string;
  labels: Record<PactPairRequesterIdV1, PactPairRelationshipLabelV1>;
};

export type PactPairActionRelationshipLabelRowV1 = {
  id: number;
  category: string;
  instruction: string;
  labels: Record<PactPairRequesterIdV1, PactPairActionRelationshipLabelV1>;
};

export type PactPairRelationshipLabelSetV2 = {
  provenance: PactPairRelationshipLabelProvenanceV1;
  qa: Map<number, PactPairQaRelationshipLabelRowV1>;
  actions: Map<number, PactPairActionRelationshipLabelRowV1>;
};

/**
 * Loads the relationship label set for a dataset root: the schema-v2 matrix
 * when present, otherwise the canonical v1.1 QA subset adapted into the same
 * normalized shape (with an empty action map).
 */
export function loadPactPairRelationshipLabelSetV2(
  rootDir: string,
): PactPairRelationshipLabelSetV2 {
  const v2Path = join(rootDir, PACT_PAIR_RELATIONSHIP_LABEL_MATRIX_V2_PATH_V1);
  if (existsSync(v2Path)) {
    const bytes = readLabelFile(v2Path);
    const matrix = pairRelationshipLabelMatrixV2Schema.parse(parseLabelJson(bytes, v2Path));
    return {
      provenance: {
        schema: PAIR_RELATIONSHIP_LABEL_MATRIX_V2_SCHEMA_ID,
        file: PACT_PAIR_RELATIONSHIP_LABEL_MATRIX_V2_PATH_V1,
        sha256: sha256Hex(bytes),
        version: matrix.version,
        qaRows: matrix.questions.length,
        actionRows: matrix.actions.length,
      },
      qa: uniqueRowMap(
        matrix.questions.map(row => ({
          id: row.id,
          category: row.category,
          question: row.question,
          labels: requesterRecord(row),
        })),
        'QA',
      ),
      actions: uniqueRowMap(
        matrix.actions.map(row => ({
          id: row.id,
          category: row.category,
          instruction: row.instruction,
          labels: requesterRecord(row),
        })),
        'action',
      ),
    };
  }

  const v1Path = join(rootDir, PACT_PAIR_RELATIONSHIP_LABEL_MATRIX_V1_PATH_V1);
  const bytes = readLabelFile(v1Path);
  const matrix = pairRelationshipLabelMatrixSchema.parse(parseLabelJson(bytes, v1Path));
  return {
    provenance: {
      schema: PAIR_RELATIONSHIP_LABEL_MATRIX_V1_SCHEMA_ID,
      file: PACT_PAIR_RELATIONSHIP_LABEL_MATRIX_V1_PATH_V1,
      sha256: sha256Hex(bytes),
      version: matrix.version,
      qaRows: matrix.labels.length,
      actionRows: 0,
    },
    qa: uniqueRowMap(
      matrix.labels.map(row => ({
        id: row.id,
        category: row.category,
        question: row.question,
        labels: requesterRecord(row),
      })),
      'QA',
    ),
    actions: new Map(),
  };
}

function requesterRecord<Label>(
  row: Record<PactPairRequesterIdV1, Label> & { id: number },
): Record<PactPairRequesterIdV1, Label> {
  return {
    R0: row.R0,
    R1: row.R1,
    R2: row.R2,
    R3: row.R3,
    R4: row.R4,
  };
}

function uniqueRowMap<Row extends { id: number }>(
  rows: Row[],
  kind: string,
): Map<number, Row> {
  const result = new Map<number, Row>();
  for (const row of rows) {
    if (result.has(row.id)) {
      throw new Error(`PACT-Pair relationship ${kind} label row ${row.id} is duplicated`);
    }
    result.set(row.id, row);
  }
  return result;
}

function readLabelFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(
      `Unable to load PACT-Pair relationship labels at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseLabelJson(bytes: Buffer, path: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `PACT-Pair relationship labels at ${path} are not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
