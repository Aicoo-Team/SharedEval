import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sharedeval-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = join(directory, 'manager.mjs');
  const log = join(directory, 'calls.txt');
  await writeFile(manager, [
    "import { appendFileSync } from 'node:fs';",
    "const script = process.argv.at(-1);",
    "appendFileSync(process.env.CHECK_TEST_LOG, script + '\\n');",
    "if (script === process.env.CHECK_TEST_FAIL) process.exit(7);",
  ].join('\n'));
  return { manager, log };
}

test('check runs existing validation, type-check and tests in order', async t => {
  const { manager, log } = await fixture(t);
  const result = spawnSync(process.execPath, [resolve('scripts/check.mjs')], {
    env: { ...process.env, npm_execpath: manager, CHECK_TEST_LOG: log, CHECK_TEST_FAIL: '' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(log, 'utf8'), 'validate\ntype-check\ntest\n');
});

test('check preserves failure exit code and does not run later steps', async t => {
  const { manager, log } = await fixture(t);
  const result = spawnSync(process.execPath, [resolve('scripts/check.mjs')], {
    env: { ...process.env, npm_execpath: manager, CHECK_TEST_LOG: log, CHECK_TEST_FAIL: 'type-check' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(await readFile(log, 'utf8'), 'validate\ntype-check\n');
});
