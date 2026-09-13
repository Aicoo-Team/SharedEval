import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetWorldSnapshot } from '../src/suites/pact-net/world/session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 4 || process.argv[2] !== '--output' || !process.argv[3]) throw new Error('Usage: tsx scripts/verify-pact-net-world.ts --output NEW_DIRECTORY');
const directory = resolve(process.argv[3]);
await mkdir(directory, { mode: 0o700 }); // Existing evidence is never overwritten.
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const commands: unknown[] = [];
const summaries: unknown[] = [];
type Evidence = NetWorldSnapshot & { stop_reason: string };
for (const mode of ['multi', 'single'] as const) {
  const output = join(directory, mode);
  const profile = join(root, `tests/suites/pact-net/fixtures/procurement-world-${mode}.json`);
  async function invoke(turns: number, phase: string): Promise<Evidence> {
    const args = ['--import', 'tsx', join(root, 'scripts/pact-net-world.ts'), '--profile', profile, '--output', output, '--max-turns', String(turns)];
    const stdout = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, SHAREDEVAL_REQUIRE_SHAREDOS: '1' }, timeout: 180_000 });
    commands.push({ mode, phase, executable: process.execPath, args, stdout });
    const evidence = JSON.parse(await readFile(join(output, 'evidence.json'), 'utf8')) as Evidence;
    await writeFile(join(directory, `${mode}-${phase}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(directory, 'commands.json'), `${JSON.stringify(commands, null, 2)}\n`, { mode: 0o600 });
    return evidence;
  }
  const boundary = await invoke(8, 'case-a-complete');
  assert.equal(boundary.processed.length, 8);
  assert.equal(boundary.current_case_index, 1);
  assert.equal(boundary.world_complete, false);
  assert.equal(boundary.cases[0]!.final_state.status, 'released');
  assert.equal(boundary.cases[1]!.event_log.length, 0);
  assert.ok(boundary.cases[1]!.context_commit!.before.every(frontier => mode === 'multi' ? frontier.sequence > 0 : frontier.sequence === 0));
  const firstB = await invoke(1, 'case-b-started');
  assert.equal(firstB.processed.length, 9);
  assert.deepEqual(firstB.cases[0]!.event_log, boundary.cases[0]!.event_log);
  assert.equal(firstB.cases[0]!.resource_state.status, mode === 'multi' ? 'released' : 'pending_control_check');
  assert.equal(firstB.cases[1]!.event_log.length, 1);
  const complete = await invoke(40, 'complete');
  assert.equal(complete.world_complete, true);
  assert.equal(complete.terminal_success, true);
  assert.equal(complete.commit_status, 'committed');
  assert.equal(complete.processed.length, 16);
  assert.equal(new Set(complete.processed).size, 16);
  assert.deepEqual(complete.cases.map(item => item.event_log.length), [5, 5]);
  assert.deepEqual(complete.cases[0]!.event_log, boundary.cases[0]!.event_log);
  const reopen = await invoke(40, 'reopened');
  assert.deepEqual(reopen, complete);
  summaries.push({ mode, sharedos: complete.sharedos, profile_digest: complete.profile_digest,
    turns: complete.processed.length, actions: complete.cases.map(item => item.event_log.length),
    case_b_initial_frontiers: boundary.cases[1]!.context_commit!.before,
    earlier_resource_during_b: firstB.cases[0]!.resource_state.status,
    prior_events_preserved: true, completed_reopen_unchanged: true });
}
const summary = { head, evidence_kind: 'scripted-native-runtime-world', stages: '8 -> 9 -> 16 -> unchanged in separate CLI processes', modes: summaries };
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ summary: join(directory, 'summary.json'), head, modes: 2 }));
