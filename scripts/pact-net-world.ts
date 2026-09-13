import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProcurementWorldProfile } from '../src/suites/pact-net/world/profile.js';
import { openNetWorld } from '../src/suites/pact-net/world/session.js';
import { parseWorldArgs } from '../src/suites/pact-net/world/cli.js';
import { scriptedPilotDriver } from '../src/suites/pact-net/pilot/driver.js';

const { directory, profilePath, turns } = parseWorldArgs(process.argv.slice(2));
const profile = await loadProcurementWorldProfile(profilePath);
const session = await openNetWorld({ directory, runId: 'assigned-procurement-world', profile, createDriver: scriptedPilotDriver() });
try {
  for (let index = 0; index < turns; index++) if (!await session.runNext()) break;
  const snapshot = session.snapshot();
  const evidence = { ...snapshot, stop_reason: snapshot.world_complete ? 'world_complete' : snapshot.blocked ? 'blocked' : turns === 0 ? 'checkpoint_only' : 'turn_limit' };
  await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ evidence: join(resolve(directory), 'evidence.json'), mode: evidence.mode,
    world_complete: evidence.world_complete, terminal_success: evidence.terminal_success,
    turns: evidence.processed.length, pending_deliveries: evidence.queue.length,
    cases: evidence.cases.map(item => ({ case_id: item.case_id, status: item.final_state.status })) }));
} finally { await session.close(); }
