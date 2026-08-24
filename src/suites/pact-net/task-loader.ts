import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pactTaskIntroV1Schema,
  type PactIdentityV1,
  type PactTaskIntroV1,
} from '../../protocol/v1/index.js';
import {
  pactNetBenchmarkV1Schema,
  pactNetContactGraphV1Schema,
  type PactNetActionV1,
  type PactNetContactGraphV1,
  type PactNetQaRelationalLabelV1,
  type PactNetQuestionV1,
  type PactNetSensitiveFactV1,
} from './schemas.js';

export const PACT_NET_POLICIES_V1 = ['D0', 'D2'] as const;
export type PactNetPolicyV1 = typeof PACT_NET_POLICIES_V1[number];

export type PactNetTaskFilterKindV1 = 'all' | 'qa' | 'action';

export type PactNetQaExpectationV1 = 'answer' | 'refuse' | 'either' | 'blocked';
export type PactNetActionExpectationV1 = 'execute' | 'refuse';

export type LoadPactNetTasksV1Options = {
  rootDir?: string;
  policy: PactNetPolicyV1;
  kind?: PactNetTaskFilterKindV1;
  ids?: string[];
  limit?: number;
};

type LoadedPactNetTaskBaseV1 = {
  taskId: string;
  policy: PactNetPolicyV1;
  category: string;
  sourceAgent: string;
  targetAgent: string;
  /**
   * Contact-graph routing verdict for the single benchmark dyad
   * (source_agent → target_agent). See routingAllowsPactNetMessageV1 for the
   * direction decision and its evidence.
   */
  routingAllowed: boolean;
  /** The source agent's relational label for this task. */
  relationalLabel: PactNetQaRelationalLabelV1;
  publicTask: PactTaskIntroV1;
};

export type LoadedPactNetQaTaskV1 = LoadedPactNetTaskBaseV1 & {
  kind: 'qa';
  question: PactNetQuestionV1;
  expectedBehavior: PactNetQaExpectationV1;
  sensitiveFactsInScope: PactNetSensitiveFactV1[];
};

export type LoadedPactNetActionTaskV1 = LoadedPactNetTaskBaseV1 & {
  kind: 'action';
  action: PactNetActionV1;
  expectedBehavior: PactNetActionExpectationV1;
};

export type LoadedPactNetTaskV1 =
  | LoadedPactNetQaTaskV1
  | LoadedPactNetActionTaskV1;

/**
 * Routing rule (fixed here for the whole suite): a message from `source` to
 * `target` is deliverable if and only if `target` appears in `source`'s own
 * contact list — DESIGN §3: "An agent can only message agents in its contacts
 * list" (the sender's list).
 *
 * Decision record: the working spec initially suggested the opposite
 * direction ("allow when the target's contacts contain the source", matching
 * the wording of some BLOCKED rationales). Against the shipped dataset that
 * direction misclassifies 12 of 997 tasks — 2 non_contact_probes on the two
 * one-way edges (marcus_webb→alex_chen, jamie_lin→tina_rodriguez) would be
 * delivered, and 10 legitimate tasks riding those same edges would be
 * blocked. The sender-side rule classifies all 997 tasks consistently
 * (probes are exactly the tasks with target ∉ contacts[source]), so the
 * sender-side rule is authoritative and the rationale wording is treated as
 * editorial. Flagged for lead review in the introducing PR.
 */
export function routingAllowsPactNetMessageV1(
  graph: Pick<PactNetContactGraphV1, 'contacts'>,
  sourceAgent: string,
  targetAgent: string,
): boolean {
  const contacts = graph.contacts[sourceAgent];
  if (!contacts) {
    throw new Error(`PACT-Net agent ${sourceAgent} has no contact list`);
  }
  return contacts.includes(targetAgent);
}

export function requirePactNetPolicyV1(policy: string): PactNetPolicyV1 {
  if (!(PACT_NET_POLICIES_V1 as readonly string[]).includes(policy)) {
    throw new Error(
      `PACT-Net supports policies ${PACT_NET_POLICIES_V1.join(', ')}, got ${policy}`,
    );
  }
  return policy as PactNetPolicyV1;
}

/**
 * Loads the canonical PACT-Net tasks and builds their public protocol view.
 * Gold facts, minimum-correct rubrics, source locations, relational labels,
 * sensitive-fact scopes, gold checks, delegation chains, and planted facts
 * remain on the private loaded task and are never copied into publicTask.
 */
export function loadPactNetTasksV1(
  options: LoadPactNetTasksV1Options,
): LoadedPactNetTaskV1[] {
  validateOptions(options);
  const rootDir = options.rootDir ?? defaultRootDir();
  const datasetRoot = join(rootDir, 'dataset', 'pact-net');
  const benchmark = pactNetBenchmarkV1Schema.parse(
    readJson(join(datasetRoot, 'tasks', 'pact_net_tasks.json')),
  );
  const graph = pactNetContactGraphV1Schema.parse(
    readJson(join(datasetRoot, 'world_design', 'contact_graph.json')),
  );

  const qaTasks = benchmark.questions.map(question => {
    requireKnownAgents(graph, question.id, question.source_agent, question.target_agent);
    const routingAllowed = routingAllowsPactNetMessageV1(
      graph,
      question.source_agent,
      question.target_agent,
    );
    const isProbe = question.category === 'non_contact_probe';
    if (isProbe === routingAllowed) {
      throw new Error(
        `PACT-Net task ${question.id} (${question.category}) conflicts with the `
        + `contact graph: routing ${routingAllowed ? 'allows' : 'blocks'} `
        + `${question.source_agent} → ${question.target_agent}`,
      );
    }
    const label = question.relational_labels[question.source_agent]?.label;
    if (!label) {
      throw new Error(`PACT-Net task ${question.id} has no source-agent label`);
    }
    const publicTask = pactTaskIntroV1Schema.parse({
      taskId: question.id,
      kind: 'qa',
      prompt: question.question,
      requester: identityFor(graph, question.source_agent),
      target: identityFor(graph, question.target_agent),
      surface: question.surface,
    });
    return {
      taskId: question.id,
      kind: 'qa',
      policy: options.policy,
      category: question.category,
      sourceAgent: question.source_agent,
      targetAgent: question.target_agent,
      routingAllowed,
      relationalLabel: label,
      question,
      expectedBehavior: qaExpectationFromLabel(label),
      sensitiveFactsInScope: question.sensitive_facts_in_scope,
      publicTask,
    } satisfies LoadedPactNetQaTaskV1;
  });

  const actionTasks = benchmark.actions.map(action => {
    requireKnownAgents(graph, action.id, action.source_agent, action.target_agent);
    const routingAllowed = routingAllowsPactNetMessageV1(
      graph,
      action.source_agent,
      action.target_agent,
    );
    if (!routingAllowed) {
      throw new Error(
        `PACT-Net action ${action.id} is not deliverable: `
        + `${action.target_agent} is not in ${action.source_agent}'s contacts`,
      );
    }
    const label = action.relational_labels[action.source_agent]?.label;
    if (!label) {
      throw new Error(`PACT-Net action ${action.id} has no source-agent label`);
    }
    const publicTask = pactTaskIntroV1Schema.parse({
      taskId: action.id,
      kind: 'action',
      prompt: action.instruction,
      requester: identityFor(graph, action.source_agent),
      target: identityFor(graph, action.target_agent),
      surface: action.surface,
      operation: action.operation,
    });
    return {
      taskId: action.id,
      kind: 'action',
      policy: options.policy,
      category: action.category,
      sourceAgent: action.source_agent,
      targetAgent: action.target_agent,
      routingAllowed,
      relationalLabel: label,
      action,
      expectedBehavior: action.expected_verdict,
      publicTask,
    } satisfies LoadedPactNetActionTaskV1;
  });

  const kind = options.kind ?? 'all';
  const candidates: LoadedPactNetTaskV1[] = kind === 'qa'
    ? qaTasks
    : kind === 'action'
      ? actionTasks
      : [...qaTasks, ...actionTasks];
  assertUniqueTaskIds(candidates);

  const selected = selectIds(candidates, options.ids, kind);
  return options.limit === undefined ? selected : selected.slice(0, options.limit);
}

function qaExpectationFromLabel(
  label: PactNetQaRelationalLabelV1,
): PactNetQaExpectationV1 {
  if (label === 'L') return 'answer';
  if (label === 'P') return 'refuse';
  if (label === 'B') return 'either';
  return 'blocked';
}

function identityFor(graph: PactNetContactGraphV1, agent: string): PactIdentityV1 {
  const entry = graph.agents[agent];
  return {
    id: agent,
    displayName: displayNameFor(agent),
    // The public relationship string is the agent's coarse world role, which
    // is world knowledge every agent shares; relational access labels are
    // private gold and never appear here.
    ...(entry ? { relationship: entry.role } : {}),
  };
}

function displayNameFor(agent: string): string {
  return agent
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function requireKnownAgents(
  graph: PactNetContactGraphV1,
  taskId: string,
  sourceAgent: string,
  targetAgent: string,
): void {
  for (const agent of [sourceAgent, targetAgent]) {
    if (!graph.agents[agent]) {
      throw new Error(`PACT-Net task ${taskId} references unknown agent ${agent}`);
    }
  }
  if (sourceAgent === targetAgent) {
    throw new Error(`PACT-Net task ${taskId} is not dyadic (source equals target)`);
  }
}

function validateOptions(options: LoadPactNetTasksV1Options): void {
  requirePactNetPolicyV1(options.policy);
  if (options.kind && !['all', 'qa', 'action'].includes(options.kind)) {
    throw new Error(`Unsupported PACT-Net task kind ${String(options.kind)}`);
  }
  if (
    options.limit !== undefined
    && (!Number.isSafeInteger(options.limit) || options.limit <= 0)
  ) {
    throw new Error('PACT-Net task limit must be a positive safe integer');
  }
  if (options.ids && new Set(options.ids.map(normalizePactNetTaskIdV1)).size !== options.ids.length) {
    throw new Error('PACT-Net task ids must be unique');
  }
}

function assertUniqueTaskIds(tasks: LoadedPactNetTaskV1[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.taskId)) {
      throw new Error(`PACT-Net task id ${task.taskId} is duplicated`);
    }
    seen.add(task.taskId);
  }
}

function selectIds(
  candidates: LoadedPactNetTaskV1[],
  requestedIds: string[] | undefined,
  kind: PactNetTaskFilterKindV1,
): LoadedPactNetTaskV1[] {
  if (!requestedIds) return candidates;
  const byId = new Map(candidates.map(task => [task.taskId, task] as const));
  return requestedIds.map(requestedId => {
    const normalizedId = normalizePactNetTaskIdV1(requestedId);
    const task = byId.get(normalizedId);
    if (!task) {
      throw new Error(
        `PACT-Net task ${requestedId} does not exist${kind === 'all' ? '' : ` in the ${kind} filter`}`,
      );
    }
    return task;
  });
}

export function normalizePactNetTaskIdV1(input: string): string {
  const match = /^(?:NET-)?([QA])-?(\d{1,4})$/i.exec(input.trim());
  if (!match) {
    throw new Error(
      `Invalid PACT-Net task id ${JSON.stringify(input)}; use NET-Q-#### or NET-A-####`,
    );
  }
  return `NET-${match[1]?.toUpperCase()}-${String(Number(match[2])).padStart(4, '0')}`;
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

function defaultRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
