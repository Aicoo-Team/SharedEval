import type { PactBenchmarkRunResultV1 } from './runner.js';

export const PACT_CLI_FAILURE_GROUP_LIMIT_V1 = 10;
export const PACT_CLI_FAILURE_TASK_ID_LIMIT_V1 = 10;
export const PACT_CLI_FAILURE_MESSAGE_LIMIT_V1 = 2_000;

export type PactCliFailureGroupV1 = {
  kind: 'error' | 'finalize_error';
  message: string;
  count: number;
  taskIds: string[];
  omittedTaskIds: number;
};

export type PactCliFailureDiagnosticsV1 = {
  groups: PactCliFailureGroupV1[];
  omittedGroups: number;
};

type MutableFailureGroup = Omit<PactCliFailureGroupV1, 'omittedTaskIds'>;

/**
 * Build a bounded, machine-readable summary from public, already-sanitized
 * task errors. Private traces and evaluation artifacts never enter this path.
 */
export function buildPactCliFailureDiagnosticsV1(
  result: PactBenchmarkRunResultV1,
): PactCliFailureDiagnosticsV1 | undefined {
  if (result.summary.errors === 0) return undefined;

  const groups = new Map<string, MutableFailureGroup>();
  for (const task of result.tasks) {
    if (task.status !== 'infrastructure_error') continue;
    const diagnostics: Array<{
      kind: PactCliFailureGroupV1['kind'];
      message: string;
    }> = [];
    if (task.error) diagnostics.push({ kind: 'error', message: task.error });
    if (task.finalizeError) {
      diagnostics.push({ kind: 'finalize_error', message: task.finalizeError });
    }
    if (diagnostics.length === 0) {
      diagnostics.push({ kind: 'error', message: 'Unknown infrastructure error' });
    }

    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.kind}\0${diagnostic.message}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.taskIds.includes(task.taskId)) {
          existing.taskIds.push(task.taskId);
          existing.taskIds.sort(compareText);
          existing.taskIds.splice(PACT_CLI_FAILURE_TASK_ID_LIMIT_V1);
        }
        continue;
      }
      groups.set(key, {
        kind: diagnostic.kind,
        message: diagnostic.message.slice(0, PACT_CLI_FAILURE_MESSAGE_LIMIT_V1),
        count: 1,
        taskIds: [task.taskId],
      });
    }
  }

  const allGroups = [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) =>
      right.count - left.count || compareText(leftKey, rightKey))
    .map(([, group]) => group);
  const visibleGroups = allGroups
    .slice(0, PACT_CLI_FAILURE_GROUP_LIMIT_V1)
    .map(group => ({
      ...group,
      omittedTaskIds: Math.max(0, group.count - group.taskIds.length),
    }));
  return {
    groups: visibleGroups,
    omittedGroups: Math.max(0, allGroups.length - visibleGroups.length),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
