import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSharedevalRunConfigV1Yaml } from '../../src/runner/v1/sharedeval-config.js';

const scriptPath = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..', 'scripts', 'experiments', 'gen-mt-configs.mjs',
);

test('generates ten multi-turn split configs covering all 600 tasks exactly once', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'mt-configs-'));
  try {
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>(done => {
      execFile('node', [scriptPath, '--out', outDir], (error, stdout) => {
        done({ code: error === null ? 0 : 1, stdout });
      });
    });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /total unique tasks: 600/);

    const files = (await readdir(outDir)).sort();
    assert.equal(files.length, 10);

    const allIds = new Set<string>();
    for (const file of files) {
      const config = parseSharedevalRunConfigV1Yaml(await readFile(join(outDir, file), 'utf8'));
      assert.deepEqual(config.workflow.multiTurn, { phase2StartTick: 61, finalizeTick: 230 });
      assert.equal(config.workflow.maxTicks, 240);
      assert.equal(config.benchmark.policy, 'D2');
      assert.equal(config.benchmark.requester, 'R1');
      const ids = config.benchmark.tasks.ids ?? [];
      assert.equal(ids.length, 60);
      for (const id of ids) {
        assert.equal(allIds.has(id), false, `duplicate ${id}`);
        allIds.add(id);
      }
    }
    assert.equal(allIds.size, 600);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
