import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dataStoreSchema,
  sensitivitySchema,
  type PairDataStore,
} from './schemas.js';

export type PactPairNoteV1 = PairDataStore['notes'][number];
export type PactPairTodoV1 = PairDataStore['todos'][number];
export type PactPairNoteFolderV1 = PairDataStore['note_folders'][number];
export type PactPairTodoFolderV1 = PairDataStore['todo_folders'][number];
export type PactPairWorkspaceSnapshotV1 = PairDataStore;

export type PactPairWorkspaceV1Options = {
  now?: () => string;
};

export class PactPairWorkspaceErrorV1 extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid_operation',
    message: string,
  ) {
    super(message);
    this.name = 'PactPairWorkspaceErrorV1';
  }
}

let cachedCanonicalStore: PairDataStore | undefined;

/**
 * Loads and validates the canonical public PACT-Pair workspace. A fresh deep
 * clone is returned on every call so a task can never mutate another task's
 * seed state.
 */
export function loadCanonicalPactPairStoreV1(): PairDataStore {
  if (!cachedCanonicalStore) {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const source = readFileSync(
      join(
        repoRoot,
        'dataset',
        'pact-pair',
        'data_spec',
        'alex_data_store.json',
      ),
      'utf8',
    );
    cachedCanonicalStore = dataStoreSchema.parse(JSON.parse(source));
  }
  return clonePairStore(cachedCanonicalStore);
}

export function clonePactPairWorkspaceSnapshotV1(
  snapshot: PactPairWorkspaceSnapshotV1,
): PactPairWorkspaceSnapshotV1 {
  return clonePairStore(dataStoreSchema.parse(snapshot));
}

export function createPactPairWorkspaceV1(
  seed: PairDataStore = loadCanonicalPactPairStoreV1(),
  options: PactPairWorkspaceV1Options = {},
): PactPairWorkspaceV1 {
  return new PactPairWorkspaceV1(seed, options);
}

export class PactPairWorkspaceV1 {
  private store: PairDataStore;
  private readonly now: () => string;

  constructor(
    seed: PairDataStore = loadCanonicalPactPairStoreV1(),
    options: PactPairWorkspaceV1Options = {},
  ) {
    this.store = clonePairStore(dataStoreSchema.parse(seed));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): PactPairWorkspaceSnapshotV1 {
    return clonePairStore(this.store);
  }

  cloneStore(): PairDataStore {
    return this.snapshot();
  }

  restore(snapshot: PactPairWorkspaceSnapshotV1): void {
    this.store = clonePairStore(dataStoreSchema.parse(snapshot));
  }

  listNoteFolders(): PactPairNoteFolderV1[] {
    return structuredClone(this.store.note_folders);
  }

  listTodoFolders(): PactPairTodoFolderV1[] {
    return structuredClone(this.store.todo_folders);
  }

  getNoteFolderByName(name: string): PactPairNoteFolderV1 {
    const folder = this.store.note_folders.find(candidate => sameText(candidate.name, name));
    if (!folder) throw notFound('Note folder', name);
    return structuredClone(folder);
  }

  getTodoFolderByName(name: string): PactPairTodoFolderV1 {
    const folder = this.store.todo_folders.find(candidate => sameText(candidate.name, name));
    if (!folder) throw notFound('Todo folder', name);
    return structuredClone(folder);
  }

  getNoteByTitle(title: string): PactPairNoteV1 {
    const note = this.store.notes.find(candidate => sameText(candidate.title, title));
    if (!note) throw notFound('Note', title);
    return structuredClone(note);
  }

  findNotesByTitle(title: string): PactPairNoteV1[] {
    return this.store.notes
      .filter(candidate => sameText(candidate.title, title))
      .map(note => structuredClone(note));
  }

  getTodoByTitle(title: string): PactPairTodoV1 {
    const todo = this.store.todos.find(candidate => sameText(candidate.title, title));
    if (!todo) throw notFound('Todo', title);
    return structuredClone(todo);
  }

  searchNotes(query: string): PactPairNoteV1[] {
    return rankTextRecords(
      this.store.notes,
      query,
      note => note.title,
      note => note.content,
    ).map(note => structuredClone(note));
  }

  searchTodos(query: string): PactPairTodoV1[] {
    return rankTextRecords(
      this.store.todos,
      query,
      todo => todo.title,
      todo => todo.description,
    ).map(todo => structuredClone(todo));
  }

  createNote(input: {
    folder: string;
    title: string;
    content: string;
  }): PactPairNoteV1 {
    const folder = this.getNoteFolderByName(input.folder);
    return this.createNoteInFolder(folder.id, {
      title: input.title,
      content: input.content,
    });
  }

  createNoteInFolder(
    folderId: number,
    input: { title: string; content: string },
  ): PactPairNoteV1 {
    const folder = this.store.note_folders.find(candidate => candidate.id === folderId);
    if (!folder) throw notFound('Note folder id', String(folderId));
    if (this.store.notes.some(note =>
      note.folderId === folder.id && sameText(note.title, input.title))) {
      throw new PactPairWorkspaceErrorV1(
        'conflict',
        `A note named ${JSON.stringify(input.title)} already exists in that folder`,
      );
    }
    const note: PactPairNoteV1 = {
      id: nextId(this.store.notes),
      folderId: folder.id,
      title: input.title,
      content: input.content,
    };
    this.store.notes.push(note);
    return structuredClone(note);
  }

  editNote(input: { title: string; content: string }): PactPairNoteV1 {
    const index = this.store.notes.findIndex(note => sameText(note.title, input.title));
    if (index === -1) throw notFound('Note', input.title);
    const current = this.store.notes[index];
    if (!current) throw notFound('Note', input.title);
    const updated: PactPairNoteV1 = { ...current, content: input.content };
    this.store.notes[index] = updated;
    return structuredClone(updated);
  }

  editNoteById(id: number, content: string): PactPairNoteV1 {
    const index = this.store.notes.findIndex(note => note.id === id);
    if (index === -1) throw notFound('Note id', String(id));
    const current = this.store.notes[index];
    if (!current) throw notFound('Note id', String(id));
    const updated: PactPairNoteV1 = { ...current, content };
    this.store.notes[index] = updated;
    return structuredClone(updated);
  }

  createTodo(input: {
    folder: string;
    title: string;
    description: string;
    priority?: number;
    dueDate?: string;
  }): PactPairTodoV1 {
    if (this.store.todos.some(todo => sameText(todo.title, input.title))) {
      throw new PactPairWorkspaceErrorV1(
        'conflict',
        `A todo named ${JSON.stringify(input.title)} already exists`,
      );
    }
    const folder = this.getTodoFolderByName(input.folder);
    const todo: PactPairTodoV1 = {
      id: nextId(this.store.todos),
      title: input.title,
      description: input.description,
      folderId: folder.id,
      priority: input.priority ?? 1,
      category: todoCategoryForFolder(folder),
      completed: false,
      dueDate: input.dueDate ?? 'unspecified',
    };
    this.store.todos.push(todo);
    return structuredClone(todo);
  }

  editTodo(input: {
    title: string;
    description?: string;
    priority?: number;
    dueDate?: string;
  }): PactPairTodoV1 {
    const index = this.store.todos.findIndex(todo => sameText(todo.title, input.title));
    if (index === -1) throw notFound('Todo', input.title);
    const current = this.store.todos[index];
    if (!current) throw notFound('Todo', input.title);
    if (
      input.description === undefined
      && input.priority === undefined
      && input.dueDate === undefined
    ) {
      throw new PactPairWorkspaceErrorV1(
        'invalid_operation',
        'Todo edit requires at least one changed field',
      );
    }

    const common = {
      ...current,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
    };
    const updated: PactPairTodoV1 = current.completed
      ? common
      : {
          ...common,
          completed: false,
          dueDate: input.dueDate ?? current.dueDate,
        };
    this.store.todos[index] = updated;
    return structuredClone(updated);
  }

  completeTodo(input: { title: string }): PactPairTodoV1 {
    const index = this.store.todos.findIndex(todo => sameText(todo.title, input.title));
    if (index === -1) throw notFound('Todo', input.title);
    const current = this.store.todos[index];
    if (!current) throw notFound('Todo', input.title);
    if (current.completed) return structuredClone(current);

    const updated: PactPairTodoV1 = {
      id: current.id,
      title: current.title,
      description: current.description,
      folderId: current.folderId,
      priority: current.priority,
      category: current.category,
      completed: true,
      completedAt: this.now(),
    };
    this.store.todos[index] = updated;
    return structuredClone(updated);
  }
}

function todoCategoryForFolder(
  folder: PactPairTodoFolderV1,
): PactPairTodoV1['category'] {
  const parsed = sensitivitySchema.safeParse(folder.sensitivity);
  if (parsed.success) return parsed.data;
  if (folder.sensitivity === 'mixed') return 'personal_relationships';
  throw new PactPairWorkspaceErrorV1(
    'invalid_operation',
    `Todo folder ${JSON.stringify(folder.name)} has an unsupported sensitivity`,
  );
}

function nextId(records: Array<{ id: number }>): number {
  return records.reduce((maximum, record) => Math.max(maximum, record.id), 0) + 1;
}

function clonePairStore(store: PairDataStore): PairDataStore {
  return structuredClone(store);
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

const SEARCH_STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'at', 'be', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it',
  'me', 'my', 'need', 'needs', 'of', 'on', 'or', 'our', 'please', 'should',
  'tell', 'the', 'their', 'to', 'us', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'with', 'would', 'you', 'your', 'currently', 'techflow',
]);

const SEARCH_TOKEN_ALIASES: Record<string, string[]> = {
  cryptocurrency: ['crypto', 'investment'],
  database: ['data', 'architecture', 'postgresql', 'neon'],
  handles: ['contact', 'twitter', 'linkedin', 'github'],
  languages: ['internationalization', 'localization', 'spanish', 'japanese'],
  medications: ['prescription', 'prescriptions', 'refill', 'albuterol'],
  replication: ['replica', 'replicas', 'architecture'],
  retirement: ['401k', 'roth', 'pension'],
  therapist: ['therapy', 'counseling'],
  treatments: ['treatment', 'appointment', 'shot', 'therapy'],
  workout: ['gym', 'run', 'running', 'fitness'],
  tos: ['terms', 'service'],
};

const SEARCH_PHRASE_ALIASES: Array<[RegExp, string[]]> = [
  [/social media/i, ['contact', 'content', 'calendar', 'twitter', 'linkedin']],
  [/customer acquisition cost/i, ['cac', 'growth', 'strategy']],
  [/international (?:markets|languages)/i, ['internationalization', 'localization']],
  [/eu customers/i, ['residency', 'replica', 'architecture', 'dpa']],
  [/planning to support/i, ['internationalization', 'localization']],
  [/ship releases/i, ['release', 'deploy', 'deployment']],
  [/getting married/i, ['wedding', 'venue']],
  [/thinking about leaving/i, ['staying', 'retention', 'grad', 'school']],
  [/underperforming/i, ['performance', 'feedback', 'improvement']],
  [/medical follow-?ups/i, ['recheck', 'cholesterol', 'appointment']],
  [/ongoing medical treatments/i, ['allergy', 'shot', 'therapy', 'appointment']],
  [/fitness routine/i, ['run', 'running', 'training', 'gym']],
  [/family health concerns/i, ['dad', 'diabetes', 'family']],
  [/compensation package/i, ['offer', 'salary', 'equity', 'maria']],
  [/work out/i, ['gym', 'membership', 'fitness']],
  [/monthly active user/i, ['mau', 'customer', 'metrics']],
  [/performance improvement plan/i, ['pip', 'documentation']],
  [/partner jamie/i, ['promotion', 'dinner', 'celebrate']],
  [/emergency medication/i, ['epipen', 'prescription', 'allergy']],
];

function rankTextRecords<T extends { id: number }>(
  records: T[],
  query: string,
  titleOf: (record: T) => string,
  bodyOf: (record: T) => string,
): T[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = expandedQueryTokens(query);

  return records
    .map(record => {
      const title = normalizeText(titleOf(record));
      const body = normalizeText(bodyOf(record));
      const titleTokens = expandedTokenSet(tokenizeSearchText(title));
      const bodyTokens = expandedTokenSet(tokenizeSearchText(body));
      let score = 0;

      if (normalizedQuery.length > 0 && `${title}\n${body}`.includes(normalizedQuery)) {
        score += 100;
      }
      for (const token of queryTokens) {
        if (titleTokens.has(token)) score += 4;
        if (bodyTokens.has(token)) score += 1;
      }
      return { record, score };
    })
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.record.id - right.record.id)
    .map(candidate => candidate.record);
}

function tokenizeSearchText(value: string): string[] {
  return normalizeText(value).match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) ?? [];
}

function expandedQueryTokens(query: string): string[] {
  const base = tokenizeSearchText(query).filter(token => !SEARCH_STOPWORDS.has(token));
  const expanded = new Set(base.flatMap(token => [
    ...tokenVariants(token),
    ...(SEARCH_TOKEN_ALIASES[token] ?? []).flatMap(tokenVariants),
  ]));
  for (const [pattern, aliases] of SEARCH_PHRASE_ALIASES) {
    if (pattern.test(query)) aliases.flatMap(tokenVariants).forEach(token => expanded.add(token));
  }
  return [...expanded];
}

function expandedTokenSet(tokens: string[]): Set<string> {
  return new Set(tokens.flatMap(tokenVariants));
}

function tokenVariants(token: string): string[] {
  const variants = new Set([token]);
  token.split(/[-']/).filter(part => part.length > 1).forEach(part => variants.add(part));
  if (token.length > 4 && token.endsWith('ies')) variants.add(`${token.slice(0, -3)}y`);
  if (token.length > 4 && token.endsWith('ing')) variants.add(token.slice(0, -3));
  if (token.length > 3 && token.endsWith('ed')) variants.add(token.slice(0, -2));
  if (token.length > 4 && token.endsWith('es')) variants.add(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('s')) variants.add(token.slice(0, -1));
  return [...variants];
}

function notFound(kind: string, value: string): PactPairWorkspaceErrorV1 {
  return new PactPairWorkspaceErrorV1(
    'not_found',
    `${kind} ${JSON.stringify(value)} was not found`,
  );
}
