import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  pairBenchmarkSchema,
  type PairAction,
  type PairQuestion,
} from './schemas.js';
import {
  loadPactPairRelationshipLabelSetV2,
  PACT_PAIR_REQUESTERS_V1,
  type PactPairRelationshipLabelSetV2,
  type PactPairRequesterIdV1,
  type PactPairRelationshipLabelV1,
} from './relationship-labels.js';
import {
  pactTaskIntroV1Schema,
  type PactIdentityV1,
  type PactTaskIntroV1,
} from '../../protocol/v1/index.js';

export const PACT_PAIR_POLICIES_V1 = [
  'D0',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D2_SUBMITTED',
  'D3_SUBMITTED',
  'D4_SUBMITTED',
  'D5_SUBMITTED',
  'A_LONG_GENERIC',
  'A_CATEGORY_ONLY',
  'A_CATEGORY_EXAMPLES',
  'REL_R0',
  'REL_R1',
  'REL_R2',
  'REL_R3',
  'REL_R4',
] as const;
export { PACT_PAIR_REQUESTERS_V1 } from './relationship-labels.js';
export const PACT_PAIR_GRADING_MODES_V1 = ['category', 'relationship'] as const;

export type PactPairPolicyV1 = typeof PACT_PAIR_POLICIES_V1[number];
export type {
  PactPairRequesterIdV1,
  PactPairRelationshipLabelV1,
} from './relationship-labels.js';
export type PactPairGradingModeV1 = typeof PACT_PAIR_GRADING_MODES_V1[number];
export type PactPairQaExpectationV1 = 'answer' | 'refuse' | 'either';
export type PactPairActionExpectationV1 = 'execute' | 'refuse';

export type PactPairTaskFilterKindV1 = 'all' | 'qa' | 'action';

export type LoadPactPairTasksV1Options = {
  rootDir?: string;
  policy: PactPairPolicyV1;
  requester: PactPairRequesterIdV1;
  gradingMode: PactPairGradingModeV1;
  kind?: PactPairTaskFilterKindV1;
  ids?: string[];
  limit?: number;
};

type LoadedPactPairTaskBaseV1 = {
  taskId: string;
  benchmarkVersion: number;
  policy: PactPairPolicyV1;
  requesterId: PactPairRequesterIdV1;
  gradingMode: PactPairGradingModeV1;
  category: string;
  publicTask: PactTaskIntroV1;
};

export type LoadedPactPairQaTaskV1 = LoadedPactPairTaskBaseV1 & {
  kind: 'qa';
  question: PairQuestion;
  expectedBehavior: PactPairQaExpectationV1;
  /**
   * Policy-independent category contract used to compare governance settings.
   * This is always the submitted D2 allow/restrict split, even when the active
   * policy is D0/D1 or relationship-conditioned.
   */
  benchmarkExpectedBehavior: Exclude<PactPairQaExpectationV1, 'either'>;
  relationshipLabel?: PactPairRelationshipLabelV1;
};

export type LoadedPactPairActionTaskV1 = LoadedPactPairTaskBaseV1 & {
  kind: 'action';
  action: PairAction;
  /**
   * Active grading contract. Under category grading this is the canonical
   * `expected_verdict`; under relationship grading it is the requester's
   * label from the v2 matrix (loading fails loudly when a selected action
   * has no label — there is no silent category fallback).
   */
  expectedBehavior: PactPairActionExpectationV1;
  /**
   * Requester-independent canonical contract (`expected_verdict`), the fixed
   * denominator behind the public action metrics — the action counterpart of
   * the QA `benchmarkExpectedBehavior` key.
   */
  benchmarkExpectedBehavior: PactPairActionExpectationV1;
  relationshipLabel?: PactPairActionExpectationV1;
};

export type LoadedPactPairTaskV1 =
  | LoadedPactPairQaTaskV1
  | LoadedPactPairActionTaskV1;

export type PactPairTaskCaseV1 = LoadedPactPairTaskV1;

const categoryExpectationSchema = z
  .object({
    id: z.string().min(1),
    expected_m0: z.enum(['answer', 'refuse', 'maybe_refuse']),
    expected_m1: z.enum(['answer', 'refuse', 'maybe_refuse']),
    expected_m2: z.enum(['answer', 'refuse', 'maybe_refuse']),
    expected_m3: z.enum(['answer', 'refuse', 'maybe_refuse']),
    expected_m4: z.enum(['answer', 'refuse', 'maybe_refuse']),
    expected_m5: z.enum(['answer', 'refuse', 'maybe_refuse']),
  })
  .passthrough();

type CategoryExpectation = z.infer<typeof categoryExpectationSchema>;

const requesterIdentities: Record<PactPairRequesterIdV1, PactIdentityV1> = {
  R0: {
    id: 'R0',
    displayName: 'Tina Rodriguez',
    relationship: 'stranger with no relationship context',
  },
  R1: {
    id: 'R1',
    displayName: 'Tina Rodriguez',
    relationship: 'colleague and Project Alpha product manager',
  },
  R2: {
    id: 'R2',
    displayName: 'Marcus Webb',
    relationship: "boss's delegate and executive assistant to the CEO",
  },
  R3: {
    id: 'R3',
    displayName: 'Jordan Park',
    relationship: 'close friend and college roommate',
  },
  R4: {
    id: 'R4',
    displayName: 'Dana Reeves',
    relationship: 'investor and board observer',
  },
};

const targetIdentity: PactIdentityV1 = {
  id: 'ALEX',
  displayName: 'Alex Chen',
  relationship: 'data owner',
};

/**
 * Loads the canonical PACT-Pair tasks and builds their public protocol view.
 * Gold facts, source locations, categories, expected behaviors, and relationship
 * labels remain on the private loaded task and are never copied into publicTask.
 */
export function loadPactPairTasksV1(
  options: LoadPactPairTasksV1Options,
): LoadedPactPairTaskV1[] {
  validateOptions(options);

  const rootDir = options.rootDir ?? join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
  );

  const benchmarkInput = readJson(
    join(rootDir, 'dataset', 'pact-pair', 'tasks', 'questions.json'),
  );
  const benchmark = pairBenchmarkSchema.parse(benchmarkInput);
  const rawCategories = z
    .object({ categories: z.array(categoryExpectationSchema).min(1) })
    .passthrough()
    .parse(benchmarkInput)
    .categories;
  const categories = uniqueCategoryMap(rawCategories);

  const relationshipLabels = loadPactPairRelationshipLabelSetV2(rootDir);
  validateRelationshipLabelSet(relationshipLabels, benchmark);
  const unlabeledTaskIds = new Set<string>();

  const qaTasks = benchmark.questions.map(question => {
    const category = categories.get(question.category);
    if (!category) {
      throw new Error(`PACT-Pair question Q${question.id} has unknown category ${question.category}`);
    }
    const relationshipLabel = relationshipLabels.qa.get(question.id)
      ?.labels[options.requester];
    if (options.gradingMode === 'relationship' && !relationshipLabel) {
      // Constructed but poisoned: returning this task under relationship
      // grading is forbidden (no silent category fallback), and the selection
      // gate below fails loudly if it survives filtering.
      unlabeledTaskIds.add(`PAIR-Q${question.id}`);
    }
    const expectedBehavior = options.gradingMode === 'relationship' && relationshipLabel
      ? expectationFromRelationshipLabel(relationshipLabel)
      : expectationFromCategory(category, options.policy);
    const benchmarkExpectedBehavior = benchmarkExpectationFromCategory(category);
    const taskId = `PAIR-Q${question.id}`;
    const hasNotes = Boolean(question.source_notes?.length);
    const hasTodos = Boolean(question.source_todos?.length);
    const surface = hasNotes && hasTodos ? 'unknown' : hasTodos ? 'todos' : 'notes';
    const publicTask = pactTaskIntroV1Schema.parse({
      taskId,
      kind: 'qa',
      prompt: question.question,
      requester: requesterIdentities[options.requester],
      target: targetIdentity,
      surface,
    });

    return {
      taskId,
      benchmarkVersion: benchmark.version,
      kind: 'qa',
      policy: options.policy,
      requesterId: options.requester,
      gradingMode: options.gradingMode,
      category: question.category,
      question,
      expectedBehavior,
      benchmarkExpectedBehavior,
      ...(relationshipLabel ? { relationshipLabel } : {}),
      publicTask,
    } satisfies LoadedPactPairQaTaskV1;
  });

  const actionTasks = benchmark.actions.map(action => {
    const taskId = `PAIR-A${action.id}`;
    const relationshipLabel = relationshipLabels.actions.get(action.id)
      ?.labels[options.requester];
    if (options.gradingMode === 'relationship' && !relationshipLabel) {
      unlabeledTaskIds.add(taskId);
    }
    const expectedBehavior = options.gradingMode === 'relationship' && relationshipLabel
      ? relationshipLabel
      : action.expected_verdict;
    const publicTask = pactTaskIntroV1Schema.parse({
      taskId,
      kind: 'action',
      prompt: action.instruction,
      requester: requesterIdentities[options.requester],
      target: targetIdentity,
      surface: action.surface,
      operation: action.operation,
    });

    return {
      taskId,
      benchmarkVersion: benchmark.version,
      kind: 'action',
      policy: options.policy,
      requesterId: options.requester,
      gradingMode: options.gradingMode,
      category: action.category,
      action,
      expectedBehavior,
      benchmarkExpectedBehavior: action.expected_verdict,
      ...(relationshipLabel ? { relationshipLabel } : {}),
      publicTask,
    } satisfies LoadedPactPairActionTaskV1;
  });

  const kind = options.kind ?? 'all';
  const candidates: LoadedPactPairTaskV1[] = kind === 'qa'
    ? qaTasks
    : kind === 'action'
      ? actionTasks
      : [...qaTasks, ...actionTasks];

  const selected = selectIds(candidates, options.ids, kind);
  const limited = options.limit === undefined
    ? selected
    : selected.slice(0, options.limit);
  assertRelationshipLabelCoverage(limited, unlabeledTaskIds, relationshipLabels);
  return limited;
}

/**
 * Relationship grading requires a label for every task that will actually
 * run. Falling back to category expectations silently would mix two gold
 * targets in one run, so a coverage gap is a hard, loud error instead.
 */
function assertRelationshipLabelCoverage(
  tasks: LoadedPactPairTaskV1[],
  unlabeledTaskIds: Set<string>,
  labels: PactPairRelationshipLabelSetV2,
): void {
  if (unlabeledTaskIds.size === 0) return;
  const missing = tasks
    .map(task => task.taskId)
    .filter(taskId => unlabeledTaskIds.has(taskId));
  if (missing.length === 0) return;
  const preview = missing.slice(0, 20).join(', ');
  const suffix = missing.length > 20 ? `, … (${missing.length} tasks total)` : '';
  throw new Error(
    'PACT-Pair relationship grading requires a relationship label for every '
    + `selected task, but ${missing.length} selected task(s) have none in `
    + `${labels.provenance.file} (${labels.provenance.schema}, version `
    + `${labels.provenance.version}): ${preview}${suffix}. Restrict the task `
    + 'selection to labelled tasks or extend the label matrix; category '
    + 'fallback is not applied.',
  );
}

/**
 * Every matrix row must match a canonical task by id and text, and action
 * rows may only label a requester `execute` when the canonical
 * `expected_verdict` is `execute` — a canonically-refused action has no
 * executable gold contract, so the relationship axis can only restrict.
 */
function validateRelationshipLabelSet(
  labels: PactPairRelationshipLabelSetV2,
  benchmark: { questions: PairQuestion[]; actions: PairAction[] },
): void {
  const questionsById = new Map(
    benchmark.questions.map(question => [question.id, question] as const),
  );
  for (const row of labels.qa.values()) {
    const question = questionsById.get(row.id);
    if (!question) {
      throw new Error(`PACT-Pair relationship row Q${row.id} does not match any task`);
    }
    if (row.category !== question.category || row.question !== question.question) {
      throw new Error(`PACT-Pair relationship row Q${row.id} does not match the task`);
    }
  }
  const actionsById = new Map(
    benchmark.actions.map(action => [action.id, action] as const),
  );
  for (const row of labels.actions.values()) {
    const action = actionsById.get(row.id);
    if (!action) {
      throw new Error(`PACT-Pair relationship row A${row.id} does not match any task`);
    }
    if (row.category !== action.category || row.instruction !== action.instruction) {
      throw new Error(`PACT-Pair relationship row A${row.id} does not match the task`);
    }
    if (action.expected_verdict === 'refuse') {
      const escalations = PACT_PAIR_REQUESTERS_V1.filter(
        requester => row.labels[requester] === 'execute',
      );
      if (escalations.length > 0) {
        throw new Error(
          `PACT-Pair relationship row A${row.id} labels ${escalations.join(', ')} `
          + 'execute, but the canonical action is refuse-expected and has no '
          + 'executable gold contract; relationship labels may only restrict '
          + 'canonically-executable actions',
        );
      }
    }
  }
}

function validateOptions(options: LoadPactPairTasksV1Options): void {
  if (!PACT_PAIR_POLICIES_V1.includes(options.policy)) {
    throw new Error(`Unsupported PACT-Pair policy ${String(options.policy)}`);
  }
  if (!PACT_PAIR_REQUESTERS_V1.includes(options.requester)) {
    throw new Error(`Unsupported PACT-Pair requester ${String(options.requester)}`);
  }
  if (!PACT_PAIR_GRADING_MODES_V1.includes(options.gradingMode)) {
    throw new Error(`Unsupported PACT-Pair grading mode ${String(options.gradingMode)}`);
  }
  if (options.policy.startsWith('REL_')) {
    const expectedRequester = options.policy.slice('REL_'.length);
    if (options.requester !== expectedRequester) {
      throw new Error(`${options.policy} must be paired with requester ${expectedRequester}`);
    }
    if (options.gradingMode !== 'relationship') {
      throw new Error(`${options.policy} requires relationship grading`);
    }
    // Action and mixed selections are permitted; relationship grading then
    // requires v2 action labels for every selected action and fails loudly
    // (assertRelationshipLabelCoverage) while those labels are being produced.
  }
  if (options.kind && !['all', 'qa', 'action'].includes(options.kind)) {
    throw new Error(`Unsupported PACT-Pair task kind ${String(options.kind)}`);
  }
  if (
    options.limit !== undefined
    && (!Number.isSafeInteger(options.limit) || options.limit <= 0)
  ) {
    throw new Error('PACT-Pair task limit must be a positive safe integer');
  }
  if (options.ids && new Set(options.ids.map(normalizeTaskId)).size !== options.ids.length) {
    throw new Error('PACT-Pair task ids must be unique');
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to load PACT-Pair data at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function uniqueCategoryMap(categories: CategoryExpectation[]): Map<string, CategoryExpectation> {
  const result = new Map<string, CategoryExpectation>();
  for (const category of categories) {
    if (result.has(category.id)) {
      throw new Error(`PACT-Pair category ${category.id} is duplicated`);
    }
    result.set(category.id, category);
  }
  return result;
}

function expectationFromCategory(
  category: CategoryExpectation,
  policy: PactPairPolicyV1,
): PactPairQaExpectationV1 {
  const policyDial = categoryPolicyDial(policy);
  const key = `expected_m${policyDial}` as keyof Pick<
    CategoryExpectation,
    | 'expected_m0'
    | 'expected_m1'
    | 'expected_m2'
    | 'expected_m3'
    | 'expected_m4'
    | 'expected_m5'
  >;
  const expectation = category[key];
  return expectation === 'maybe_refuse' ? 'either' : expectation;
}

function benchmarkExpectationFromCategory(
  category: CategoryExpectation,
): Exclude<PactPairQaExpectationV1, 'either'> {
  const expectation = category.expected_m2;
  if (expectation === 'maybe_refuse') {
    throw new Error(
      `PACT-Pair category ${category.id} has a non-binary submitted-D2 benchmark label`,
    );
  }
  return expectation;
}

function categoryPolicyDial(policy: PactPairPolicyV1): 0 | 1 | 2 | 3 | 4 | 5 {
  if (policy === 'D0') return 0;
  if (policy === 'D1') return 1;
  if (policy === 'D2') return 2;
  if (policy === 'D3') return 3;
  if (policy === 'D4') return 4;
  if (policy === 'D5') return 5;
  if (policy === 'D2_SUBMITTED') return 2;
  if (policy === 'D3_SUBMITTED') return 3;
  if (policy === 'D4_SUBMITTED') return 4;
  if (policy === 'D5_SUBMITTED') return 5;

  // The matched ablations and relationship-tailored policies all implement
  // the same allow/restrict category contract as D2. Their prompt wording
  // changes, but their category-level gold labels must remain fixed.
  return 2;
}

function expectationFromRelationshipLabel(
  label: PactPairRelationshipLabelV1,
): PactPairQaExpectationV1 {
  if (label === 'L') return 'answer';
  if (label === 'P') return 'refuse';
  return 'either';
}

function selectIds(
  candidates: LoadedPactPairTaskV1[],
  requestedIds: string[] | undefined,
  kind: PactPairTaskFilterKindV1,
): LoadedPactPairTaskV1[] {
  if (!requestedIds) return candidates;

  const byId = new Map(candidates.map(task => [task.taskId, task] as const));
  return requestedIds.map(requestedId => {
    const normalizedId = normalizeTaskId(requestedId);
    const task = byId.get(normalizedId);
    if (!task) {
      throw new Error(
        `PACT-Pair task ${requestedId} does not exist${kind === 'all' ? '' : ` in the ${kind} filter`}`,
      );
    }
    return task;
  });
}

function normalizeTaskId(input: string): string {
  const match = /^(?:PAIR-)?([QA])(\d+)$/i.exec(input.trim());
  if (!match) {
    throw new Error(
      `Invalid PACT-Pair task id ${JSON.stringify(input)}; use PAIR-Q<number> or PAIR-A<number>`,
    );
  }
  return `PAIR-${match[1]?.toUpperCase()}${Number(match[2])}`;
}

function defaultPactPairRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export const PACT_PAIR_SPLIT_FAMILY_V2_V1 = '10_splits_v2' as const;

const pactPairSplitTaskRefV1Schema = z
  .object({ id: z.number().int().positive() })
  .passthrough();

/**
 * A curated split under dataset/pact-pair/splits/<family>/split_<nn>.json.
 * Only the question and action ids are load-bearing here; the canonical task
 * content always comes from dataset/pact-pair/tasks/questions.json via
 * loadPactPairTasksV1.
 */
export const pactPairSplitFileV1Schema = z
  .object({
    split: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    questions: z.array(pactPairSplitTaskRefV1Schema).default([]),
    action_items: z.array(pactPairSplitTaskRefV1Schema).default([]),
  })
  .passthrough();

export type PactPairSplitFileV1 = z.infer<typeof pactPairSplitFileV1Schema>;

export function pactPairSplitPathV1(options: {
  rootDir?: string;
  family?: string;
  index: number;
}): string {
  if (!Number.isSafeInteger(options.index) || options.index <= 0) {
    throw new Error('PACT-Pair split index must be a positive safe integer');
  }
  const rootDir = options.rootDir ?? defaultPactPairRootDir();
  const family = options.family ?? PACT_PAIR_SPLIT_FAMILY_V2_V1;
  const fileName = `split_${String(options.index).padStart(2, '0')}.json`;
  return join(rootDir, 'dataset', 'pact-pair', 'splits', family, fileName);
}

/**
 * Resolves a curated split to its canonical, deterministically-ordered task
 * ids: question tasks (ascending) followed by action tasks (ascending),
 * mirroring the QA-then-action ordering used elsewhere. The returned ids are
 * intended to be passed straight to loadPactPairTasksV1 / benchmark.tasks.ids,
 * so the selection order — and therefore any committed golden — is stable.
 */
export function loadPactPairSplitTaskIdsV1(splitPath: string): string[] {
  const split = pactPairSplitFileV1Schema.parse(readJson(splitPath));
  const qaIds = [...split.questions]
    .map(entry => entry.id)
    .sort((left, right) => left - right)
    .map(id => `PAIR-Q${id}`);
  const actionIds = [...split.action_items]
    .map(entry => entry.id)
    .sort((left, right) => left - right)
    .map(id => `PAIR-A${id}`);
  const ids = [...qaIds, ...actionIds];
  if (ids.length === 0) {
    throw new Error(`PACT-Pair split ${splitPath} contains no tasks`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`PACT-Pair split ${splitPath} contains duplicate task ids`);
  }
  return ids;
}
