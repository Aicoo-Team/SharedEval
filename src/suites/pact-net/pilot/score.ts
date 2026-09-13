import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { JsonObject } from '../../../contracts/json.js';
import { projectPilotEvaluation } from './evaluation.js';
import type { PilotProfile } from './profile.js';

const executeFile = promisify(execFile);
const fraction = z.number().finite().min(0).max(1);
const evaluationSchema = z.object({
  task_id: z.literal('P-01'), contract_version: z.literal('1.0'),
  safety_passed: z.boolean(), full_completion: z.boolean(),
  checkpoint_points: z.number().int().safe().nonnegative(),
  checkpoint_total: z.number().int().safe().positive(),
  checkpoint_ratio: fraction, score: fraction,
  checkpoints: z.array(z.object({
    id: z.string().min(1), label: z.string().min(1),
    weight: z.number().int().safe().nonnegative(), passed: z.boolean(), details: z.array(z.string()),
  }).strict()).min(1),
  safety_gates: z.array(z.object({
    id: z.string().min(1), passed: z.boolean(), hard_fail: z.boolean(), details: z.array(z.string()),
  }).strict()).min(1),
}).strict().refine(result => result.checkpoint_points <= result.checkpoint_total,
  'checkpoint points cannot exceed the total');

/** Explicit post-hoc evaluation of registered P-01 evidence; never used during execution. */
export async function evaluatePilotEvidence(options: {
  profile: PilotProfile; evidence: unknown; dataDirectory: string;
}): Promise<{ submission: ReturnType<typeof projectPilotEvaluation>; evaluation: JsonObject }> {
  // Registration, closure and audit checks must precede filesystem or evaluator effects.
  const submission = projectPilotEvaluation(options.profile, options.evidence);
  const directory = await mkdtemp(join(tmpdir(), 'pact-net-pilot-score-'));
  try {
    const submissionPath = join(directory, 'submission.json');
    await writeFile(submissionPath, `${JSON.stringify(submission, null, 2)}\n`, { mode: 0o600 });
    const dataDirectory = resolve(options.dataDirectory);
    const { stdout } = await executeFile('python3', [
      join(dataDirectory, 'scripts/evaluate_executable_task.py'), dataDirectory, 'P-01', submissionPath,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 });
    let evaluation: JsonObject;
    try { evaluation = evaluationSchema.parse(JSON.parse(stdout)); }
    catch (cause) { throw new Error('pilot_evaluation_result_invalid', { cause }); }
    return { submission, evaluation };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
