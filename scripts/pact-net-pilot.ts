import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPilotProfile } from '../src/suites/pact-net/pilot/profile.js';
import { openNetPilot } from '../src/suites/pact-net/pilot/session.js';
import { parsePilotArgs } from '../src/suites/pact-net/pilot/cli.js';
import { scriptedPilotDriver } from '../src/suites/pact-net/pilot/driver.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { directory, mode, turns } = parsePilotArgs(process.argv.slice(2));
const profile = await loadPilotProfile(join(root, 'dataset/pact-net/tasks/executable_core/P-01/initial_state.json'), mode);
const session = await openNetPilot({ directory, runId: 'p01-native-pilot', profile, createDriver: scriptedPilotDriver() });
try {
  for (let index = 0; index < turns; index++) if (!await session.runNext()) break;
  const snapshot = session.snapshot();
  const evidence = { ...snapshot, stop_reason: turns === 0 ? 'checkpoint_only' : snapshot.queue.length ? 'turn_limit' : 'queue_drained' };
  await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ evidence: join(resolve(directory), 'evidence.json'), terminal_success: evidence.terminal_success, turns: evidence.processed.length, pending_deliveries: evidence.queue.length, status: evidence.final_state.status }));
} finally { await session.close(); }
