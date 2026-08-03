/**
 * Input normalization for the evaluation tools.
 *
 * Three known results.jsonl shapes are accepted and normalized into one
 * record type keyed by taskId:
 *   - 'pact-results':          this repo's runner output (publicTask + finalDecision)
 *   - 'pulse-single-step':     pulse research/runs single-step records
 *                              (questionId + contactMessage + alexResponse)
 *   - 'platform-observation':  pulse experiment-platform Observation rows
 *                              (observationId + io.{contactMessage,responderOutput})
 *
 * Normalization never drops a line silently: unrecognized lines throw with
 * their line number so a malformed run surfaces immediately.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type SourceFormat =
  | 'pact-results'
  | 'pulse-single-step'
  | 'platform-observation';

export type NormalizedRecord = {
  taskId: string;
  observationId: string | null;
  /** Requester-authored outbound message; null when the format has none. */
  contactMessage: string | null;
  /** Terminal responder text (answer content or refusal reason). */
  responseText: string | null;
  decision: 'answer' | 'refuse' | 'escalate' | 'none';
  sourceFormat: SourceFormat;
  raw: unknown;
};

const pactResultsLineSchema = z
  .object({
    taskId: z.string().min(1),
    finalDecision: z
      .object({
        type: z.enum(['answer', 'refuse', 'escalate']),
        content: z.string().optional(),
        reason: z.string().optional(),
      })
      .nullable()
      .optional(),
    publicTask: z.object({}).passthrough(),
  })
  .passthrough();

const pulseSingleStepLineSchema = z
  .object({
    questionId: z.number().int().positive(),
    contactMessage: z.string().nullable().optional(),
    alexResponse: z.string().nullable().optional(),
  })
  .passthrough();

const platformObservationLineSchema = z
  .object({
    observationId: z.string().min(1),
    taskId: z.string().min(1),
    io: z
      .object({
        contactMessage: z.string().nullable(),
        responderOutput: z.string().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export function canonicalTaskId(taskId: string): string {
  return taskId.replace(/^PAIR-/, '');
}

export function detectFormat(line: Record<string, unknown>): SourceFormat | null {
  if ('publicTask' in line && 'taskId' in line) return 'pact-results';
  if ('observationId' in line && 'io' in line) return 'platform-observation';
  if ('questionId' in line && ('alexResponse' in line || 'contactMessage' in line)) {
    return 'pulse-single-step';
  }
  return null;
}

export function normalizeLine(line: Record<string, unknown>): NormalizedRecord {
  const format = detectFormat(line);
  if (format === 'pact-results') {
    const parsed = pactResultsLineSchema.parse(line);
    const decision = parsed.finalDecision ?? null;
    return {
      // Runner task ids are prefixed ("PAIR-Q1"); the question set keys by "Q1".
      taskId: canonicalTaskId(parsed.taskId),
      observationId: null,
      // The PACT-pair prompt is benchmark-authored, not agent-authored, so
      // there is no contact message to grade in this format.
      contactMessage: null,
      responseText: decision ? decision.content ?? decision.reason ?? null : null,
      decision: decision?.type ?? 'none',
      sourceFormat: format,
      raw: line,
    };
  }
  if (format === 'platform-observation') {
    const parsed = platformObservationLineSchema.parse(line);
    return {
      taskId: parsed.taskId,
      observationId: parsed.observationId,
      contactMessage: parsed.io.contactMessage,
      responseText: parsed.io.responderOutput,
      decision: parsed.io.responderOutput === null ? 'none' : 'answer',
      sourceFormat: format,
      raw: line,
    };
  }
  if (format === 'pulse-single-step') {
    const parsed = pulseSingleStepLineSchema.parse(line);
    const response = parsed.alexResponse ?? null;
    return {
      taskId: `Q${parsed.questionId}`,
      observationId: null,
      contactMessage: parsed.contactMessage ?? null,
      responseText: response,
      decision: response === null ? 'none' : 'answer',
      sourceFormat: format,
      raw: line,
    };
  }
  throw new Error('unrecognized results line shape');
}

export function loadResults(path: string): NormalizedRecord[] {
  const lines = readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0);
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${index + 1}: invalid JSON`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path}:${index + 1}: expected a JSON object`);
    }
    try {
      return normalizeLine(parsed as Record<string, unknown>);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}:${index + 1}: ${detail}`);
    }
  });
}

/** Latest record wins when a task id appears more than once (retry runs). */
export function indexByTask(records: NormalizedRecord[]): Map<string, NormalizedRecord> {
  const byTask = new Map<string, NormalizedRecord>();
  for (const record of records) byTask.set(record.taskId, record);
  return byTask;
}

// ── Question set ────────────────────────────────────────────────────────────

export const evalQuestionSchema = z
  .object({
    id: z.number().int().positive(),
    category: z.string().min(1),
    question: z.string().min(1),
    gold_key_facts: z.array(z.string().min(1)).min(1),
    minimum_correct: z.string().min(1),
  })
  .passthrough();
export type EvalQuestion = z.infer<typeof evalQuestionSchema>;

const questionFileSchema = z
  .object({ questions: z.array(evalQuestionSchema).min(1) })
  .passthrough();

export function loadQuestions(path: string): Map<string, EvalQuestion> {
  const parsed = questionFileSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
  const byTask = new Map<string, EvalQuestion>();
  for (const question of parsed.questions) byTask.set(`Q${question.id}`, question);
  return byTask;
}

/**
 * Parses a fixed-denominator declaration like "1-200,301" into task ids.
 * Returns null when unset (callers then default to the whole question set).
 */
export function parseTaskIds(spec: string | null): string[] | null {
  if (!spec) return null;
  const ids: string[] = [];
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Number.parseInt(range[1] ?? '', 10);
      const end = Number.parseInt(range[2] ?? '', 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new Error(`invalid task-id range: ${part}`);
      }
      for (let i = start; i <= end; i += 1) ids.push(`Q${i}`);
      continue;
    }
    if (/^\d+$/.test(part)) {
      ids.push(`Q${part}`);
      continue;
    }
    ids.push(part);
  }
  return [...new Set(ids)];
}
