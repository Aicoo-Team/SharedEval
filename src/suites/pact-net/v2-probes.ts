/**
 * Single-hop disclosure probes derived from the PACT-Net v2 task set.
 *
 * Every v2 task is a multi-party scenario (`A→{B,C}` and wider), and 136 of them
 * carry exactly one `forbidden` entry: a fact, the agent who holds it, and the
 * agent it must not reach. A multi-party scenario is a set of pairwise exchanges,
 * so the forbidden entry names a single edge that can be probed on its own --
 * `forbidden_to` asks `holder` directly, and the question is whether the fact
 * comes back.
 *
 * This is the one thing v2 can score mechanically as it ships. Its rubric is
 * `human_review_required` on all 166 tasks and its `gold_status` is `not_built`
 * on 156, so there is no machine-checkable right answer and the utility half of a
 * differential metric cannot be computed from the dataset. The forbidden contract
 * is different: the fact is a literal string and the note holding it is named, so
 * "did this reach the agent it was withheld from" is decidable without a judge and
 * without inventing gold.
 *
 * Nothing is synthesized. The question put to the holder is the task's own `ask`,
 * the protected string is the task's own `forbidden.fact`, and the category is the
 * sensitivity of the holder's own note. A task whose pieces do not line up is
 * reported as unusable rather than patched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pactNetSensitivityV1Schema, type PactNetSensitivityV1 } from './schemas.js';

const forbiddenV2Schema = z.object({
  fact: z.string().min(1),
  holder: z.string().min(1),
  forbidden_to: z.string().min(1),
  evidence_note_title: z.string().min(1).optional(),
  evidence_ref_status: z.string().min(1),
}).passthrough();

const taskV2Schema = z.object({
  id: z.string().min(1),
  scenario: z.string().min(1),
  requester: z.string().min(1),
  participants: z.array(z.string().min(1)),
  topology: z.string().min(1),
  ask: z.string().min(1),
  forbidden: z.array(forbiddenV2Schema).optional(),
}).passthrough();

export const pactNetV2TaskFileSchema = z.object({
  version: z.union([z.number(), z.string()]),
  tasks: z.array(taskV2Schema).min(1),
}).passthrough();

const agentStoreNoteSchema = z.object({
  title: z.string().min(1),
  folder: z.string().min(1),
  sensitivity: pactNetSensitivityV1Schema,
  content: z.string().min(1),
});

const agentStoreSchema = z.object({
  agent: z.string().min(1),
  notes: z.array(agentStoreNoteSchema).min(1),
}).passthrough();

export const PACT_NET_V2_TASKS_PATH_V1 = join(
  'dataset', 'pact-net', 'tasks', 'pact_net_tasks_v2.json',
);
export const PACT_NET_V2_AGENT_CONFIG_DIR_V1 = join(
  'dataset', 'pact-net', 'agent_configs',
);

/** Why a forbidden entry cannot be probed on one hop. */
export type PactNetV2ProbeRejectionV1 =
  | 'forbidden_to_is_everyone'
  | 'forbidden_to_equals_holder'
  | 'forbidden_to_not_an_actor'
  | 'holder_not_an_actor'
  | 'holder_has_no_store'
  | 'evidence_outside_bundled_notes'
  | 'evidence_note_absent_from_holder_store'
  | 'no_eligible_contrast_asker';

/**
 * Which side of the paired contrast a probe stands on.
 *
 * `withheld` is the arm the dataset licenses outright: the forbidden entry names
 * this asker, so the fact must not reach it. `permitted` is the contrast, and its
 * basis is weaker on purpose -- see `contrastAsker`.
 */
export type PactNetV2ProbeArmV1 = 'withheld' | 'permitted';

export type PactNetV2ProbeV1 = Readonly<{
  /** Stable per-edge id: the task plus the holder being probed. */
  probeId: string;
  taskId: string;
  scenario: string;
  topology: string;
  /** The agent the fact was withheld from; it does the asking. */
  requesterAgent: string;
  /** The agent holding the fact; it answers. */
  responderAgent: string;
  /** The task's own words, unchanged. */
  ask: string;
  /** The literal protected string, from the task's own forbidden entry. */
  forbiddenFact: string;
  evidenceNoteTitle: string;
  /** Sensitivity of the holder's own note, so probes can be grouped by category. */
  category: PactNetSensitivityV1;
  /** Which arm of the paired contrast this is. */
  arm: PactNetV2ProbeArmV1;
  /**
   * The forbidden edge both arms share, so an analysis joins on this and `arm`
   * instead of parsing `probeId`.
   */
  pairId: string;
  /**
   * On the `permitted` arm only: how this asker was chosen, stated as what the
   * dataset actually supports.
   *
   * `not_named_forbidden` means no forbidden entry in the task names this actor --
   * which is NOT the same as the dataset saying the actor is entitled to the fact.
   * v2 records prohibitions, never entitlements, so nothing here licenses scoring
   * a reply on this arm as right or wrong. It licenses one thing: comparing how
   * often the value appears across the two arms of the same edge.
   */
  contrastAsker?: Readonly<{ basis: 'not_named_forbidden'; eligible: readonly string[] }>;
}>;

export type PactNetV2ProbeSetV1 = Readonly<{
  probes: readonly PactNetV2ProbeV1[];
  rejected: readonly Readonly<{
    taskId: string;
    holder: string;
    forbiddenTo: string;
    reason: PactNetV2ProbeRejectionV1;
  }>[];
}>;

function repositoryRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * alex_chen ships without a data.json because the world reuses the PACT-Pair hub
 * store for that agent. Probing alex_chen as the holder therefore needs the pair
 * store wired in, which this loader does not do, so those edges are rejected
 * rather than silently probed against someone else's notes.
 */
function loadHolderNotes(
  rootDir: string,
  agent: string,
): readonly z.infer<typeof agentStoreNoteSchema>[] | undefined {
  const path = join(rootDir, PACT_NET_V2_AGENT_CONFIG_DIR_V1, agent, 'data.json');
  try {
    return agentStoreSchema.parse(readJson(path)).notes;
  } catch {
    return undefined;
  }
}

/**
 * An agent's own notes as the world ships them, sensitivity included.
 *
 * The pair-store projection loses that field into a folder table, and deciding
 * what the holder may already say out loud needs it per note.
 */
export function readPactNetAgentNotesV1(
  agent: string,
  options: { rootDir?: string } = {},
): readonly Readonly<{ title: string; sensitivity: string; content: string }>[] {
  return loadHolderNotes(options.rootDir ?? repositoryRoot(), agent) ?? [];
}

/**
 * Derives every forbidden edge that can be probed with one request and one reply.
 *
 * `arms` defaults to `withheld`, which is the set this module has always returned:
 * one probe per edge, asked by the agent the fact was withheld from. The default
 * is load-bearing -- the calibration set and the observed-reply judge both call
 * this with no options and key their output on `probeId`, so widening the default
 * would silently double the calibration set and rekey 142 already-judged replies.
 *
 * `both` adds the contrast arm: the same holder, the same question, asked by a
 * seated actor no forbidden entry in that task names. That arm is a comparison
 * population, not a scored one; see `contrastAsker`.
 */
export function loadPactNetV2ProbesV1(
  options: {
    rootDir?: string;
    taskIds?: readonly string[];
    arms?: 'withheld' | 'both';
  } = {},
): PactNetV2ProbeSetV1 {
  const rootDir = options.rootDir ?? repositoryRoot();
  const file = pactNetV2TaskFileSchema.parse(
    readJson(join(rootDir, PACT_NET_V2_TASKS_PATH_V1)),
  );
  const wanted = options.taskIds ? new Set(options.taskIds) : undefined;
  const notesByAgent = new Map<string, ReturnType<typeof loadHolderNotes>>();
  const probes: PactNetV2ProbeV1[] = [];
  const rejected: PactNetV2ProbeSetV1['rejected'][number][] = [];

  for (const task of file.tasks) {
    if (wanted && !wanted.has(task.id)) continue;
    const actors = new Set([task.requester, ...task.participants]);
    // Every actor any forbidden entry in this task names, not only the ones this
    // holder is restricted towards. An actor the task marks restricted for some
    // other fact is a poor contrast even when this fact is not withheld from it,
    // and taking the stricter rule costs nothing: all 51 probeable edges still
    // have an eligible contrast asker under it.
    const restrictedAnywhere = new Set(
      (task.forbidden ?? []).map(entry => entry.forbidden_to),
    );
    for (const forbidden of task.forbidden ?? []) {
      const reject = (reason: PactNetV2ProbeRejectionV1): void => {
        rejected.push({
          taskId: task.id, holder: forbidden.holder,
          forbiddenTo: forbidden.forbidden_to, reason,
        });
      };
      if (forbidden.forbidden_to === 'everyone') { reject('forbidden_to_is_everyone'); continue; }
      if (forbidden.forbidden_to === forbidden.holder) { reject('forbidden_to_equals_holder'); continue; }
      if (!actors.has(forbidden.forbidden_to)) { reject('forbidden_to_not_an_actor'); continue; }
      if (!actors.has(forbidden.holder)) { reject('holder_not_an_actor'); continue; }
      if (forbidden.evidence_note_title === undefined) {
        // evidence_ref_status external_corpus_dependency: the fact is not in any
        // bundled note, so the probe has nothing to point at in the holder's store.
        reject('evidence_outside_bundled_notes');
        continue;
      }
      if (!notesByAgent.has(forbidden.holder)) {
        notesByAgent.set(forbidden.holder, loadHolderNotes(rootDir, forbidden.holder));
      }
      const notes = notesByAgent.get(forbidden.holder);
      if (!notes) { reject('holder_has_no_store'); continue; }
      const note = notes.find(candidate => candidate.title === forbidden.evidence_note_title);
      if (!note) { reject('evidence_note_absent_from_holder_store'); continue; }
      // The withheld arm keeps the id it has always had. 142 judged replies and
      // every run directory on record are keyed to it, so the contrast arm takes
      // the suffixed id rather than rekeying work already done.
      const pairId = `NET-${task.id}--${forbidden.holder}`;
      const shared = {
        pairId,
        taskId: task.id,
        scenario: task.scenario,
        topology: task.topology,
        responderAgent: forbidden.holder,
        ask: task.ask,
        forbiddenFact: forbidden.fact,
        evidenceNoteTitle: forbidden.evidence_note_title,
        category: note.sensitivity,
      } as const;
      probes.push({
        ...shared,
        probeId: pairId,
        requesterAgent: forbidden.forbidden_to,
        arm: 'withheld',
      });
      if (options.arms !== 'both') continue;
      const eligible = [task.requester, ...task.participants].filter(
        actor => actor !== forbidden.holder && !restrictedAnywhere.has(actor),
      );
      if (eligible.length === 0) { reject('no_eligible_contrast_asker'); continue; }
      // Declared order, requester first, so the same dataset always yields the
      // same pairing and a rerun is comparable with the run before it.
      const asker = eligible[0] as string;
      probes.push({
        ...shared,
        probeId: `${pairId}@${asker}`,
        requesterAgent: asker,
        arm: 'permitted',
        contrastAsker: { basis: 'not_named_forbidden', eligible },
      });
    }
  }
  return { probes, rejected };
}

/** The PACT-Pair store shape the file tools read, built from a PACT-Net agent. */
/**
 * `priority` is not written consistently in the shipped world: 18 agents use
 * low/medium/high, 35 use 1/2/3, and 6 mix both inside one file. `content` is
 * empty on 198 of 1159 todos. Both are accepted here and normalised, because a
 * loader that rejected them would reject most of the dataset -- but neither is
 * papered over silently: see pactNetTodoDataQualityV1, which counts them.
 */
const agentTodoSchema = z.object({
  title: z.string().min(1),
  folder: z.string().min(1),
  sensitivity: pactNetSensitivityV1Schema,
  priority: z.union([z.enum(['low', 'medium', 'high']), z.number().int().min(1).max(3)]),
  due_date: z.string().min(1),
  completed: z.boolean(),
  content: z.string(),
});

const fullAgentStoreSchema = z.object({
  agent: z.string().min(1),
  notes: z.array(agentStoreNoteSchema).min(1),
  todos: z.array(agentTodoSchema).min(1),
}).passthrough();

/** Most restrictive first: a folder inherits the strictest sensitivity it holds. */
const SENSITIVITY_RANK_V1: readonly PactNetSensitivityV1[] = [
  'personal_health',
  'personal_finance',
  'personal_relationships',
  'sensitive_work',
  'work_public',
];

const TODO_PRIORITY_V1 = { high: 2, medium: 1, low: 0 } as const;

/** Both spellings land on the pair store's 0..2 scale. */
function todoPriorityV1(value: 'low' | 'medium' | 'high' | number): 0 | 1 | 2 {
  if (typeof value === 'number') return (value - 1) as 0 | 1 | 2;
  return TODO_PRIORITY_V1[value];
}

export type PactNetTodoDataQualityV1 = Readonly<{
  numericPriorities: number;
  emptyContents: number;
  total: number;
}>;

export type PactNetAgentIdentityV1 = Readonly<{
  name: string;
  role: string;
  background: string;
}>;

/**
 * Reads an agent's identity from its own USER.md, three labelled lines. A missing
 * field is an error rather than a default: an invented owner would travel into the
 * run's provenance and into the responder's prompt.
 */
export function readPactNetAgentIdentityV1(
  agent: string,
  options: { rootDir?: string } = {},
): PactNetAgentIdentityV1 {
  const path = join(options.rootDir ?? repositoryRoot(),
    PACT_NET_V2_AGENT_CONFIG_DIR_V1, agent, 'USER.md');
  const text = readFileSync(path, 'utf8');
  const field = (label: string): string => {
    const match = new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(text);
    if (!match?.[1]) throw new Error(`PACT-Net ${agent} USER.md has no ${label} line`);
    return match[1].trim();
  };
  return { name: field('Name'), role: field('Role'), background: field('Background') };
}

function strictest(values: readonly PactNetSensitivityV1[]): PactNetSensitivityV1 {
  for (const candidate of SENSITIVITY_RANK_V1) {
    if (values.includes(candidate)) return candidate;
  }
  throw new Error('PACT-Net folder has no sensitivity');
}

function folderIndex(
  entries: readonly Readonly<{ folder: string; sensitivity: PactNetSensitivityV1 }>[],
): Map<string, { id: number; sensitivity: PactNetSensitivityV1 }> {
  const names = [...new Set(entries.map(entry => entry.folder))].sort();
  return new Map(names.map((name, index) => [name, {
    id: index + 1,
    sensitivity: strictest(entries.filter(e => e.folder === name).map(e => e.sensitivity)),
  }]));
}

export type PactNetAgentStoreV1 = z.infer<typeof fullAgentStoreSchema>;

/**
 * An agent's own store with its per-entry sensitivity intact.
 *
 * The pair store projection above collapses sensitivity to the folder, taking the
 * strictest label the folder holds, which is right for access but wrong for
 * asking "what does the dataset say about this note". A work_public note filed
 * beside a restricted one keeps its own label here.
 */
export function readPactNetAgentStoreV1(
  agent: string,
  options: { rootDir?: string } = {},
): PactNetAgentStoreV1 {
  return fullAgentStoreSchema.parse(readJson(join(
    options.rootDir ?? repositoryRoot(), PACT_NET_V2_AGENT_CONFIG_DIR_V1, agent, 'data.json',
  )));
}

/** Projects one PACT-Net agent's own notes and todos into the pair store shape. */
export function pactNetAgentStoreToPairStoreV1(
  agent: string,
  options: { rootDir?: string } = {},
): { store: unknown; todoQuality: PactNetTodoDataQualityV1 } {
  const rootDir = options.rootDir ?? repositoryRoot();
  const store = fullAgentStoreSchema.parse(readJson(
    join(rootDir, PACT_NET_V2_AGENT_CONFIG_DIR_V1, agent, 'data.json'),
  ));
  const identity = readPactNetAgentIdentityV1(agent, { rootDir });
  const noteFolders = folderIndex(store.notes);
  const todoFolders = folderIndex(store.todos);
  const todoQuality: PactNetTodoDataQualityV1 = {
    numericPriorities: store.todos.filter(t => typeof t.priority === 'number').length,
    emptyContents: store.todos.filter(t => t.content.trim() === '').length,
    total: store.todos.length,
  };
  const pairStore = {
    version: 1,
    description: `PACT-Net v2 store for ${agent}, projected into the PACT-Pair `
      + "store shape; folders, notes, todos and sensitivities are the agent's own.",
    owner: {
      name: identity.name,
      role: identity.role,
      company: /\bat\s+(.+)$/.exec(identity.role)?.[1]?.trim() ?? 'unspecified',
      background: identity.background,
    },
    note_folders: [...noteFolders].map(([name, folder]) => ({
      id: folder.id, name, parentId: null, sensitivity: folder.sensitivity,
    })),
    todo_folders: [...todoFolders].map(([name, folder]) => ({
      id: folder.id, name, sensitivity: folder.sensitivity,
    })),
    notes: store.notes.map((note, index) => ({
      id: index + 1,
      folderId: noteFolders.get(note.folder)!.id,
      title: note.title,
      content: note.content,
    })),
    todos: store.todos.map((todo, index) => ({
      id: index + 1,
      title: todo.title,
      description: todo.content.trim() === '' ? todo.title : todo.content,
      folderId: todoFolders.get(todo.folder)!.id,
      priority: todoPriorityV1(todo.priority),
      category: todo.sensitivity,
      ...(todo.completed
        ? { completed: true, completedAt: todo.due_date }
        : { completed: false, dueDate: todo.due_date }),
    })),
  };
  return { store: pairStore, todoQuality };
}

/**
 * Whether a probe's protected string can be found in the holder's own notes.
 *
 * `forbidden.fact` holds two different kinds of thing. Twenty-three of the
 * fifty-one probeable edges name something quotable -- a ticket id, a price, a
 * figure -- which the benchmark's matcher finds in the holder's note and can
 * therefore find again in a reply. The remaining twenty-eight describe a class of
 * information instead ("dilution and term detail", "the rest of the compensation
 * band", "patient identity list"). Deciding whether a reply disclosed a class is a
 * judgement, not a string match, which is consistent with the task set marking
 * every rubric `human_review_required`.
 *
 * Probes are not silently dropped: the caller is told which are decidable so a
 * leak rate is only ever reported over the ones that are.
 */
export type PactNetV2ProbeAnchorV1 = 'named_note' | 'sibling_note' | 'not_quotable';

/**
 * Superseded. Indicators now come from `v2-indicators.ts`, which anchors them to
 * the value the fact itself denotes rather than to whatever the evidence note
 * happened to contain. The old rule is not kept as a fallback: on the frozen
 * world it disagreed with the new one on 49 of 51 probes, so having both
 * available would only make it possible to score a run with the wrong one.
 */
export function classifyPactNetV2ProbeAnchorV1(
  probe: PactNetV2ProbeV1,
  notes: readonly Readonly<{ title: string; content: string }>[],
  containsFact: (text: string, fact: string) => boolean,
): PactNetV2ProbeAnchorV1 {
  // The holder reads a note's title as well as its body, so both are in scope.
  const whole = (note: Readonly<{ title: string; content: string }>): string =>
    `${note.title}\n${note.content}`;
  const named = notes.find(note => note.title === probe.evidenceNoteTitle);
  if (named && containsFact(whole(named), probe.forbiddenFact)) return 'named_note';
  if (notes.some(note => containsFact(whole(note), probe.forbiddenFact))) return 'sibling_note';
  return 'not_quotable';
}

/**
 * Stable question number for a probe: its rank in the whole probe set ordered by
 * probe id. Derived from the dataset rather than from a selection, so the same
 * probe keeps the same number whichever subset a run selects.
 */
export function pactNetV2ProbeNumbersV1(
  probes: readonly PactNetV2ProbeV1[],
): Map<string, number> {
  return new Map([...probes]
    .map(probe => probe.probeId)
    .sort((left, right) => left.localeCompare(right))
    .map((probeId, index) => [probeId, index + 1]));
}
