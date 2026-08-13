import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const verifyHarbor = join(repositoryRoot, 'scripts', 'verify_harbor.sh');
const nestedTestGuard = 'PACT_SKIP_REGRESSION_NESTED_TEST';

const prerequisiteCases = [
  {
    name: 'Docker executable absent',
    reason: 'Docker is not installed',
    tools: [] as ToolName[],
    dockerInfoSucceeds: false,
    expectedCalls: [] as string[],
  },
  {
    name: 'Docker daemon unavailable',
    reason: 'Docker daemon is not running',
    tools: ['docker'] as ToolName[],
    dockerInfoSucceeds: false,
    expectedCalls: ['docker info'],
  },
  {
    name: 'Harbor executable absent',
    reason: 'Harbor is not installed (run: uv tool install harbor==0.5.0)',
    tools: ['docker'] as ToolName[],
    dockerInfoSucceeds: true,
    expectedCalls: ['docker info'],
  },
  {
    name: 'SharedOS build absent',
    reason: /SharedOS build not found at .*missing-sharedos \(missing packages\/contracts\/dist\).*/,
    tools: ['docker', 'harbor'] as ToolName[],
    dockerInfoSucceeds: true,
    expectedCalls: ['docker info', 'harbor --version'],
  },
] as const;

for (const prerequisite of prerequisiteCases) {
  test(`verify_harbor: ${prerequisite.name} skips locally and fails in strict mode`, t => {
    const temporary = mkdtempSync(join(tmpdir(), 'pact-harbor-prereq-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));

    const local = runVerifyHarbor(
      temporary,
      prerequisite.tools,
      prerequisite.dockerInfoSucceeds,
      false,
    );
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, expectedLine('SKIP', prerequisite.reason));
    assert.deepEqual(readCalls(local.callsPath), prerequisite.expectedCalls);

    const strict = runVerifyHarbor(
      temporary,
      prerequisite.tools,
      prerequisite.dockerInfoSucceeds,
      true,
    );
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(
      strict.stdout,
      expectedLine('FAIL', prerequisite.reason, ' (PACT_HARBOR_SMOKE_REQUIRE=1)'),
    );
    assert.deepEqual(readCalls(strict.callsPath), prerequisite.expectedCalls);
  });
}

test('npm test logs and marks SharedOS suites skipped without a reachable build', t => {
  if (process.env[nestedTestGuard] === '1') {
    t.skip('nested npm test guard');
    return;
  }

  const temporary = mkdtempSync(join(tmpdir(), 'pact-sharedos-skip-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const npmInvocation = resolveNpmInvocation();
  const environment = { ...process.env };
  environment[nestedTestGuard] = '1';
  environment.PACT_SHAREDOS_DIR = join(temporary, 'missing-sharedos');
  delete environment.PACT_REQUIRE_SHAREDOS;
  // node:test marks worker processes with this internal variable. A fresh
  // subprocess must not inherit it or Node treats the nested command as a
  // recursive test invocation and suppresses all selected files.
  delete environment.NODE_TEST_CONTEXT;

  const child = spawnSync(npmInvocation.executable, [...npmInvocation.args, 'test'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
  });
  const output = `${child.stdout}${child.stderr}`;

  assert.equal(child.status, 0, output);
  assert.match(output, /\[sharedos-conformance\] skipping differential tests:/);
  assert.match(output, /\[sharedos-embedded\] skipping integration tests:/);
  assert.match(output, /\[sharedos-runner-wiring\] skipping integration tests:/);
  assert.match(output, /recipient addresses:.*# SKIP/);
  assert.match(output, /an authorized turn runs through.*# SKIP/);
  assert.match(output, /a QA trial runs through.*# SKIP/);
  const skipped = /# skipped (\d+)/.exec(output);
  assert.ok(skipped, 'nested npm test must report a skipped-test total');
  assert.ok(Number(skipped[1]) > 0, `expected skipped tests, got ${skipped[1]}`);
});

type ToolName = 'docker' | 'harbor';

function runVerifyHarbor(
  temporary: string,
  tools: readonly ToolName[],
  dockerInfoSucceeds: boolean,
  strict: boolean,
) {
  const mode = strict ? 'strict' : 'local';
  const root = join(temporary, mode);
  const bin = join(root, 'bin');
  const callsPath = join(root, 'calls.log');
  mkdirSync(bin, { recursive: true });
  linkCommand(bin, 'grep');
  linkCommand(bin, 'head');
  writeExecutable(
    join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' '${repositoryRoot}'\n`,
  );
  if (tools.includes('docker')) {
    writeExecutable(join(bin, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> '${callsPath}'
if [ "$1" = "info" ]; then exit ${dockerInfoSucceeds ? '0' : '1'}; fi
exit 99
`);
  }
  if (tools.includes('harbor')) {
    writeExecutable(join(bin, 'harbor'), `#!/bin/sh
printf 'harbor %s\\n' "$*" >> '${callsPath}'
if [ "$1" = "--version" ]; then echo 'harbor 0.5.0'; exit 0; fi
exit 99
`);
  }

  const environment = { ...process.env };
  environment.PATH = bin;
  environment.PACT_SHAREDOS_DIR = join(root, 'missing-sharedos');
  if (strict) environment.PACT_HARBOR_SMOKE_REQUIRE = '1';
  else delete environment.PACT_HARBOR_SMOKE_REQUIRE;
  const child = spawnSync('/bin/bash', [verifyHarbor], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
  });
  return { ...child, callsPath };
}

function expectedLine(
  prefix: 'SKIP' | 'FAIL',
  reason: string | RegExp,
  suffix = '',
): RegExp {
  const source = typeof reason === 'string' ? escapeRegExp(reason) : reason.source;
  return new RegExp(`^${prefix}: ${source}${escapeRegExp(suffix)}\\n$`);
}

function readCalls(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function linkCommand(bin: string, command: string): void {
  const resolved = spawnSync('/usr/bin/env', ['which', command], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, `required test utility not found: ${command}`);
  symlinkSync(resolved.stdout.trim(), join(bin, command));
}

function resolveNpmInvocation(): { executable: string; args: string[] } {
  if (process.env.npm_execpath) {
    return { executable: process.execPath, args: [process.env.npm_execpath] };
  }
  const resolved = spawnSync('/usr/bin/env', ['which', 'npm'], { encoding: 'utf8' });
  assert.equal(resolved.status, 0, 'npm must be available to exercise npm test');
  return { executable: resolved.stdout.trim(), args: [] };
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
