import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXPERIMENT_CELL_ID_PATTERN_V1,
  EXPERIMENT_ID_PATTERN_V1,
  MAX_EXPERIMENT_REPLICATES_V1,
  deriveExperimentCellIdV1,
  deriveExperimentPlanDigestV1,
  experimentPlanV1Schema,
  serializeExperimentPlanV1,
} from './contracts.js';
import type { ExperimentCellV1, ExperimentPlanV1 } from './contracts.js';

export const EXPERIMENT_PLAN_FILE_NAME_V1 = 'plan.json' as const;
export const EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1 = 'plan.digest' as const;
export const EXPERIMENT_RUN_ID_CELL_PREFIX_LENGTH_V1 = 24;

// Mirrors RUN_ID_PATTERN in src/runner/v1/sharedeval-production.ts (not
// exported there): every derived runId must be accepted by the production CLI.
const RUNNER_RUN_ID_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ExperimentPlanFilesV1 = Readonly<{
  mkdir(directoryPath: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  /** Must create exclusively and reject when the path already exists. */
  writeFileExclusive(filePath: string, contents: string): Promise<void>;
}>;

export function nodeExperimentPlanFilesV1(): ExperimentPlanFilesV1 {
  return {
    async mkdir(directoryPath) {
      await mkdir(directoryPath, { recursive: true });
    },
    async readFile(filePath) {
      return readFile(filePath, 'utf8');
    },
    async writeFileExclusive(filePath, contents) {
      await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
    },
  };
}

export type BoundExperimentCellV1 = Readonly<{
  planDigest: string;
  experimentId: string;
  cellId: string;
  runId: string;
  replicate: number;
  cell: ExperimentCellV1;
}>;

export type PublishedExperimentPlanV1 = Readonly<{
  plan: ExperimentPlanV1;
  planDigest: string;
  cells: readonly BoundExperimentCellV1[];
}>;

/**
 * runId = experimentId + cellId prefix + replicate. Deterministic, collision
 * checked at publish time, and always a valid production CLI run id.
 */
export function deriveExperimentRunIdV1(
  experimentId: string,
  cellId: string,
  replicate: number,
): string {
  if (!EXPERIMENT_ID_PATTERN_V1.test(experimentId)) {
    throw new Error('Experiment id is invalid for run id derivation');
  }
  if (!EXPERIMENT_CELL_ID_PATTERN_V1.test(cellId)) {
    throw new Error('Experiment cell id is invalid for run id derivation');
  }
  if (
    !Number.isSafeInteger(replicate)
    || replicate < 1
    || replicate > MAX_EXPERIMENT_REPLICATES_V1
  ) {
    throw new Error('Experiment replicate is invalid for run id derivation');
  }
  const runId = [
    experimentId,
    cellId.slice(0, EXPERIMENT_RUN_ID_CELL_PREFIX_LENGTH_V1),
    `r${replicate}`,
  ].join('.');
  if (!RUNNER_RUN_ID_PATTERN_V1.test(runId)) {
    throw new Error('Derived experiment run id is not a valid Sharedeval run id');
  }
  return runId;
}

function bindExperimentCellsV1(
  plan: ExperimentPlanV1,
  planDigest: string,
): readonly BoundExperimentCellV1[] {
  const cells = plan.cells.map(cell => {
    const cellId = deriveExperimentCellIdV1(cell);
    return {
      planDigest,
      experimentId: plan.experimentId,
      cellId,
      runId: deriveExperimentRunIdV1(plan.experimentId, cellId, cell.replicate),
      replicate: cell.replicate,
      cell,
    };
  });
  if (new Set(cells.map(cell => cell.runId)).size !== cells.length) {
    throw new Error('Experiment plan derives colliding run ids');
  }
  return cells;
}

export async function publishExperimentPlanV1(
  input: unknown,
  directory: string,
  files: ExperimentPlanFilesV1 = nodeExperimentPlanFilesV1(),
): Promise<PublishedExperimentPlanV1> {
  const plan = experimentPlanV1Schema.parse(input);
  const serialized = serializeExperimentPlanV1(plan);
  const planDigest = deriveExperimentPlanDigestV1(plan);
  const cells = bindExperimentCellsV1(plan, planDigest);
  await files.mkdir(directory);
  await files.writeFileExclusive(
    path.join(directory, EXPERIMENT_PLAN_FILE_NAME_V1),
    serialized,
  );
  await files.writeFileExclusive(
    path.join(directory, EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1),
    `${planDigest}\n`,
  );
  return { plan, planDigest, cells };
}

export async function loadExperimentPlanV1(
  directory: string,
  files: ExperimentPlanFilesV1 = nodeExperimentPlanFilesV1(),
): Promise<PublishedExperimentPlanV1> {
  let raw: string;
  try {
    raw = await files.readFile(path.join(directory, EXPERIMENT_PLAN_FILE_NAME_V1));
  } catch {
    throw new Error('Unable to read published experiment plan.json');
  }
  let storedDigestRaw: string;
  try {
    storedDigestRaw = await files.readFile(
      path.join(directory, EXPERIMENT_PLAN_DIGEST_FILE_NAME_V1),
    );
  } catch {
    throw new Error('Unable to read published experiment plan digest');
  }
  const storedDigest = storedDigestRaw.trim();
  if (!/^[a-f0-9]{64}$/.test(storedDigest)) {
    throw new Error('Published experiment plan digest file is invalid');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Published experiment plan.json is not valid JSON');
  }
  const plan = experimentPlanV1Schema.parse(parsedJson);
  if (raw !== serializeExperimentPlanV1(plan)) {
    throw new Error('Published experiment plan.json is not in canonical published form');
  }
  const planDigest = deriveExperimentPlanDigestV1(plan);
  if (planDigest !== storedDigest) {
    throw new Error('Published experiment plan.json does not match its digest');
  }
  return { plan, planDigest, cells: bindExperimentCellsV1(plan, planDigest) };
}

/**
 * A batch may only contain cells bound to one published plan: mixed batches
 * are rejected, as are accidental duplicates of one cell in a batch.
 */
export function assertSingleExperimentBatchV1(
  cells: readonly BoundExperimentCellV1[],
): void {
  if (cells.length === 0) {
    throw new Error('Experiment batch must contain at least one cell');
  }
  const planDigests = new Set(cells.map(cell => cell.planDigest));
  if (planDigests.size > 1) {
    throw new Error(
      `Experiment batch mixes cells from ${planDigests.size} published plans`,
    );
  }
  if (new Set(cells.map(cell => cell.runId)).size !== cells.length) {
    throw new Error('Experiment batch contains duplicate cells');
  }
}
