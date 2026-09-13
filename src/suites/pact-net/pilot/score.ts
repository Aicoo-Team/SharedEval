import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { JsonObject } from '../../../contracts/json.js';
import { projectPilotEvaluation } from './evaluation.js';
import type { PilotProfile } from './profile.js';
import {
  parsePilotScoringManifest, pilotEvaluationProvenanceSchema, validatePilotEvaluationResult,
  type PilotEvaluationProvenance,
} from './score-contract.js';

const executeFile = promisify(execFile);
export const pilotEvaluationLauncherV1 = Object.freeze({
  version: 'pact-net-python-evaluation-launcher/v1' as const,
  source: `import contextlib
import io
import json
import platform
import runpy
import sys

class BoundedCapture(io.StringIO):
    def __init__(self):
        super().__init__()
        self.byte_count = 0
        self.exceeded = False

    def write(self, text):
        remaining = 1048576 - self.byte_count
        if self.exceeded or len(text) > remaining or len(text.encode("utf-8")) > remaining:
            self.exceeded = True
            raise RuntimeError("pilot_evaluation_stdout_limit")
        self.byte_count += len(text.encode("utf-8"))
        return super().write(text)

runtime = {"implementation": sys.implementation.name, "version": platform.python_version()}
script, root, submission = sys.argv[1:]
sys.argv = [script, root, "P-01", submission]
captured = BoundedCapture()
with contextlib.redirect_stdout(captured):
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as exit:
        if exit.code is not None and not (isinstance(exit.code, int) and exit.code == 0):
            raise
if captured.exceeded:
    raise RuntimeError("pilot_evaluation_stdout_limit")
print(json.dumps({"evaluation": captured.getvalue(), "python": runtime}, allow_nan=False))
`,
});
const rawSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const responseSchema = z.object({
  evaluation: z.string(), python: pilotEvaluationProvenanceSchema.shape.python,
}).strict();

/** Explicit post-hoc evaluation of registered P-01 evidence; never used during execution. */
export async function evaluatePilotEvidence(options: {
  profile: PilotProfile; evidence: unknown; dataDirectory: string;
}): Promise<{ submission: ReturnType<typeof projectPilotEvaluation>; evaluation: JsonObject; provenance: PilotEvaluationProvenance }> {
  // Registration, closure and audit checks must precede filesystem or evaluator effects.
  const submission = projectPilotEvaluation(options.profile, options.evidence);
  const dataDirectory = resolve(options.dataDirectory);
  const [evaluatorBytes, manifestBytes] = await Promise.all([
    readFile(join(dataDirectory, 'scripts/evaluate_executable_task.py')),
    readFile(join(dataDirectory, 'tasks/executable_core/P-01/manifest.json')),
  ]);
  let manifest;
  try { manifest = parsePilotScoringManifest(JSON.parse(manifestBytes.toString('utf8'))); }
  catch (cause) { throw new Error('pilot_evaluation_manifest_unsupported', { cause }); }
  // Provenance v1 hashes these exact UTF-8 bytes, including indentation and the final newline.
  const submissionBytes = Buffer.from(`${JSON.stringify(submission, null, 2)}\n`, 'utf8');
  const launcherBytes = Buffer.from(pilotEvaluationLauncherV1.source, 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'pact-net-pilot-score-'));
  try {
    const capturedData = join(directory, 'dataset');
    const capturedScripts = join(capturedData, 'scripts');
    const capturedTask = join(capturedData, 'tasks/executable_core/P-01');
    await Promise.all([mkdir(capturedScripts, { recursive: true, mode: 0o700 }), mkdir(capturedTask, { recursive: true, mode: 0o700 })]);
    const submissionPath = join(directory, 'submission.json');
    const capturedEvaluator = join(capturedScripts, 'evaluate_executable_task.py');
    const launcherPath = join(directory, 'launcher.py');
    await Promise.all([
      writeFile(submissionPath, submissionBytes, { mode: 0o600 }),
      writeFile(capturedEvaluator, evaluatorBytes, { mode: 0o600 }),
      writeFile(join(capturedTask, 'manifest.json'), manifestBytes, { mode: 0o600 }),
      writeFile(launcherPath, launcherBytes, { mode: 0o600 }),
    ]);
    // The isolated interpreter uses the captured evaluator, manifest and submission.
    // Runtime identity is captured before runpy; stdlib/dependencies and the wider
    // environment are not attested by this reproducibility metadata.
    // Raw evaluator stdout is capped at 1 MiB by the launcher. JSON escaping can
    // expand that payload sixfold; reserve a bounded allowance for its envelope.
    const { stdout } = await executeFile('python3', [
      '-I', launcherPath, capturedEvaluator, capturedData, submissionPath,
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 6 * 1_048_576 + 4096 });
    try {
      const response = responseSchema.parse(JSON.parse(stdout));
      const evaluation = validatePilotEvaluationResult(JSON.parse(response.evaluation), manifest);
      const provenance = pilotEvaluationProvenanceSchema.parse({
        version: 'pact-net-p01-evaluation-provenance/v1',
        evaluatorSha256: rawSha256(evaluatorBytes), manifestSha256: rawSha256(manifestBytes),
        submissionSha256: rawSha256(submissionBytes),
        launcher: { version: pilotEvaluationLauncherV1.version, sha256: rawSha256(launcherBytes) },
        python: response.python,
      });
      return { submission, evaluation, provenance };
    }
    catch (cause) { throw new Error('pilot_evaluation_result_invalid', { cause }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
