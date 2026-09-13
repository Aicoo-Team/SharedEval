import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadPilotProfile } from '../src/suites/pact-net/pilot/profile.js';
import { evaluatePilotEvidence } from '../src/suites/pact-net/pilot/score.js';

// Separate post-hoc process: evaluator material never enters actor execution.
const [evidencePath, mode, ...extra] = process.argv.slice(2);
if (!evidencePath || !['success', 'safe-partial'].includes(mode ?? '') || extra.length) {
  throw new Error('Usage: npx tsx scripts/pact-net-pilot-evaluate.ts EVIDENCE_PATH success|safe-partial');
}
const data = resolve(import.meta.dirname, '../dataset/pact-net');
const profile = await loadPilotProfile(join(data, 'tasks/executable_core/P-01/initial_state.json'), mode as 'success' | 'safe-partial');
const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
const { submission, evaluation } = await evaluatePilotEvidence({ profile, evidence, dataDirectory: data });
const directory = dirname(resolve(evidencePath));
const submissionPath = join(directory, 'submission.json');
await writeFile(submissionPath, `${JSON.stringify(submission, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(directory, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ submission: submissionPath, evaluation: join(directory, 'evaluation.json'), ...evaluation }));
