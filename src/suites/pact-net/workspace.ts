import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dataStoreSchema,
  type PairDataStore,
} from '../pact-pair/schemas.js';
import {
  pactNetAgentStoreV1Schema,
  type PactNetAgentStoreV1,
  type PactNetNoteV1,
  type PactNetSensitivityV1,
  type PactNetTodoV1,
} from './schemas.js';

export const PACT_NET_HUB_AGENT_V1 = 'alex_chen' as const;

export type PactNetWorkspaceSnapshotV1 = PactNetAgentStoreV1;

export class PactNetWorkspaceErrorV1 extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid_operation',
    message: string,
  ) {
    super(message);
    this.name = 'PactNetWorkspaceErrorV1';
  }
}

function defaultRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Loads every agent's seed store from `dataset/pact-net/agent_configs/`.
 *
 * `alex_chen` intentionally ships without a `data.json`: the design reuses the
 * PACT-Pair hub workspace ("Reuse existing PACT-Pair data", DESIGN §2.1), so
 * the loader maps `dataset/pact-pair/data_spec/alex_data_store.json` into the
 * PACT-Net store shape here. The mapping is a load-time projection only; the
 * pair asset stays the single source of truth for Alex's data.
 */
export function loadPactNetAgentStoresV1(
  options: { rootDir?: string } = {},
): Map<string, PactNetAgentStoreV1> {
  const rootDir = options.rootDir ?? defaultRootDir();
  const configsDir = join(rootDir, 'dataset', 'pact-net', 'agent_configs');
  const agents = readdirSync(configsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (agents.length === 0) {
    throw new Error(`PACT-Net agent_configs directory is empty: ${configsDir}`);
  }

  const stores = new Map<string, PactNetAgentStoreV1>();
  for (const agent of agents) {
    if (agent === PACT_NET_HUB_AGENT_V1) {
      stores.set(agent, loadHubStoreFromPactPairV1(rootDir));
      continue;
    }
    const path = join(configsDir, agent, 'data.json');
    const store = pactNetAgentStoreV1Schema.parse(readJson(path));
    if (store.agent !== agent) {
      throw new Error(
        `PACT-Net store ${path} declares agent ${store.agent}, expected ${agent}`,
      );
    }
    stores.set(agent, store);
  }
  return stores;
}

/**
 * Maps the canonical PACT-Pair hub workspace into the PACT-Net store shape.
 *
 * - Note folders become their `parentId`-joined path (for example
 *   `Work/Projects`), matching the path-style folders in the other agents'
 *   stores.
 * - Note sensitivity derives from the pair folder sensitivity through a fixed
 *   table. The value is cosmetic for evaluation (task-level gold carries its
 *   own sensitivity); the table only keeps the seeded store within the
 *   five-category enum.
 * - Todo `category` is already the sensitivity enum; numeric priority maps to
 *   low/medium/high; completed pair todos have no due date, so the completion
 *   date stands in to satisfy the store shape.
 */
export function mapPactPairStoreToPactNetV1(
  pairStore: PairDataStore,
): PactNetAgentStoreV1 {
  const noteFolderPaths = new Map<number, string>();
  for (const folder of pairStore.note_folders) {
    noteFolderPaths.set(folder.id, folderPath(pairStore, folder.id));
  }
  const todoFolderNames = new Map(
    pairStore.todo_folders.map(folder => [folder.id, folder.name] as const),
  );
  const noteFolderSensitivity = new Map(
    pairStore.note_folders.map(folder =>
      [folder.id, mapFolderSensitivity(folder.sensitivity)] as const),
  );

  const notes: PactNetNoteV1[] = pairStore.notes.map(note => ({
    title: note.title,
    folder: noteFolderPaths.get(note.folderId) ?? 'Work',
    sensitivity: noteFolderSensitivity.get(note.folderId) ?? 'work_public',
    content: note.content,
  }));
  const todos: PactNetTodoV1[] = pairStore.todos.map(todo => ({
    title: todo.title,
    folder: todoFolderNames.get(todo.folderId) ?? 'Work',
    sensitivity: todo.category,
    priority: (['low', 'medium', 'high'] as const)[todo.priority] ?? 'medium',
    due_date: todo.completed ? todo.completedAt.slice(0, 10) : todo.dueDate,
    completed: todo.completed,
    content: todo.description,
  }));

  return pactNetAgentStoreV1Schema.parse({
    agent: PACT_NET_HUB_AGENT_V1,
    notes,
    todos,
  });
}

function loadHubStoreFromPactPairV1(rootDir: string): PactNetAgentStoreV1 {
  const path = join(rootDir, 'dataset', 'pact-pair', 'data_spec', 'alex_data_store.json');
  return mapPactPairStoreToPactNetV1(dataStoreSchema.parse(readJson(path)));
}

function folderPath(pairStore: PairDataStore, folderId: number): string {
  const parts: string[] = [];
  let current: number | null = folderId;
  const guard = new Set<number>();
  while (current !== null && !guard.has(current)) {
    guard.add(current);
    const folder = pairStore.note_folders.find(candidate => candidate.id === current);
    if (!folder) break;
    parts.unshift(folder.name);
    current = folder.parentId;
  }
  return parts.join('/');
}

function mapFolderSensitivity(value: string): PactNetSensitivityV1 {
  switch (value) {
    case 'work_public':
    case 'sensitive_work':
    case 'personal_finance':
    case 'personal_health':
    case 'personal_relationships':
      return value;
    case 'mixed':
      return 'sensitive_work';
    case 'personal':
      return 'personal_relationships';
    case 'public':
    case 'system':
      return 'work_public';
    default:
      throw new Error(`Unsupported PACT-Pair folder sensitivity ${value}`);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to load PACT-Net data at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * In-process, single-agent workspace over one PACT-Net seed store. The runner
 * creates a fresh instance from the seed for every trial, so mutations never
 * persist across tasks (snapshot → diff → implicit rollback).
 */
export class PactNetWorkspaceV1 {
  private store: PactNetAgentStoreV1;

  constructor(seed: PactNetAgentStoreV1) {
    this.store = structuredClone(pactNetAgentStoreV1Schema.parse(seed));
  }

  snapshot(): PactNetWorkspaceSnapshotV1 {
    return structuredClone(this.store);
  }

  searchNotes(query: string, limit = 10): PactNetNoteV1[] {
    return searchRecords(
      this.store.notes,
      query,
      note => note.title,
      note => note.content,
    ).slice(0, limit).map(note => structuredClone(note));
  }

  getNote(title: string): PactNetNoteV1 {
    const note = this.store.notes.find(candidate => sameText(candidate.title, title));
    if (!note) throw notFound('Note', title);
    return structuredClone(note);
  }

  createNote(input: { folder: string; title: string; content: string }): PactNetNoteV1 {
    if (this.store.notes.some(note =>
      sameText(note.folder, input.folder) && sameText(note.title, input.title))) {
      throw new PactNetWorkspaceErrorV1(
        'conflict',
        `A note named ${JSON.stringify(input.title)} already exists in that folder`,
      );
    }
    // Newly shared content defaults to work_public; the classification is
    // cosmetic for evaluation (gold checks compare folder and content only).
    const note: PactNetNoteV1 = {
      title: input.title,
      folder: input.folder,
      sensitivity: 'work_public',
      content: input.content,
    };
    this.store.notes.push(note);
    return structuredClone(note);
  }

  editNote(input: { title: string; content: string }): PactNetNoteV1 {
    const index = this.store.notes.findIndex(note => sameText(note.title, input.title));
    if (index === -1) throw notFound('Note', input.title);
    const current = this.store.notes[index];
    if (!current) throw notFound('Note', input.title);
    const updated: PactNetNoteV1 = { ...current, content: input.content };
    this.store.notes[index] = updated;
    return structuredClone(updated);
  }

  searchTodos(query: string, limit = 10): PactNetTodoV1[] {
    return searchRecords(
      this.store.todos,
      query,
      todo => todo.title,
      todo => todo.content,
    ).slice(0, limit).map(todo => structuredClone(todo));
  }

  getTodo(title: string): PactNetTodoV1 {
    const todo = this.store.todos.find(candidate => sameText(candidate.title, title));
    if (!todo) throw notFound('Todo', title);
    return structuredClone(todo);
  }

  createTodo(input: {
    folder: string;
    title: string;
    content: string;
    priority?: PactNetTodoV1['priority'];
    due_date?: string;
  }): PactNetTodoV1 {
    if (this.store.todos.some(todo => sameText(todo.title, input.title))) {
      throw new PactNetWorkspaceErrorV1(
        'conflict',
        `A todo named ${JSON.stringify(input.title)} already exists`,
      );
    }
    const todo: PactNetTodoV1 = {
      title: input.title,
      folder: input.folder,
      sensitivity: 'work_public',
      priority: input.priority ?? 'medium',
      due_date: input.due_date ?? 'unspecified',
      completed: false,
      content: input.content,
    };
    this.store.todos.push(todo);
    return structuredClone(todo);
  }

  completeTodo(input: { title: string }): PactNetTodoV1 {
    const index = this.store.todos.findIndex(todo => sameText(todo.title, input.title));
    if (index === -1) throw notFound('Todo', input.title);
    const current = this.store.todos[index];
    if (!current) throw notFound('Todo', input.title);
    if (current.completed) return structuredClone(current);
    const updated: PactNetTodoV1 = { ...current, completed: true };
    this.store.todos[index] = updated;
    return structuredClone(updated);
  }
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

function searchRecords<T>(
  records: T[],
  query: string,
  titleOf: (record: T) => string,
  bodyOf: (record: T) => string,
): T[] {
  const normalizedQuery = normalizeText(query);
  const tokens = tokenize(normalizedQuery);
  return records
    .map((record, index) => {
      const title = normalizeText(titleOf(record));
      const body = normalizeText(bodyOf(record));
      let score = 0;
      if (normalizedQuery.length > 0 && `${title}\n${body}`.includes(normalizedQuery)) {
        score += 100;
      }
      const titleTokens = new Set(tokenize(title));
      const bodyTokens = new Set(tokenize(body));
      for (const token of tokens) {
        if (titleTokens.has(token)) score += 4;
        if (bodyTokens.has(token)) score += 1;
      }
      return { record, score, index };
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(candidate => candidate.record);
}

function tokenize(value: string): string[] {
  return value.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [];
}

function notFound(kind: string, value: string): PactNetWorkspaceErrorV1 {
  return new PactNetWorkspaceErrorV1(
    'not_found',
    `${kind} ${JSON.stringify(value)} was not found`,
  );
}
