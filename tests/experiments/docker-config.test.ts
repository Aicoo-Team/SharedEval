import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// @ts-expect-error untyped operational helper (plain JS), exercised behaviorally
import { buildCellProvenanceV1, deriveCellEndpointV1, tinyproxyAllowlistV1, tinyproxyConfigV1 } from '../../scripts/experiments/run-cell-lib.mjs';
// @ts-expect-error untyped operational helper (plain JS), exercised behaviorally
import { runEgressProbeV1 } from '../../scripts/experiments/egress-probe.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const composePath = path.join(repoRoot, 'docker', 'experiments', 'compose.yaml');
const dockerfilePath = path.join(repoRoot, 'docker', 'experiments', 'Dockerfile');
const runCellPath = path.join(repoRoot, 'scripts', 'experiments', 'run-cell.sh');
const buildImagePath = path.join(repoRoot, 'scripts', 'experiments', 'build-image.sh');
const egressProbeShPath = path.join(repoRoot, 'scripts', 'experiments', 'egress-probe.sh');

const httpsConfig = `
apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://openrouter.ai/api/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: example-model
workflow:
  mode: multi
  protocol: files
  maxTicks: 240
  stopWhen: all-terminal
output:
  directory: runs
  saveTraces: false
`;

const plainHttpConfig = httpsConfig.replace(
  'https://openrouter.ai/api/v1',
  'http://198.51.100.7/v1',
);

type ScriptResult = { code: number; stdout: string; stderr: string };

async function runBash(
  scriptPath: string,
  args: readonly string[],
  environment: Record<string, string>,
): Promise<ScriptResult> {
  return await new Promise(resolvePromise => {
    execFile(
      'bash',
      [scriptPath, ...args],
      { env: environment },
      (error, stdout, stderr) => {
        const rawCode = (error as { code?: unknown } | null)?.code;
        const code = error === null ? 0 : typeof rawCode === 'number' ? rawCode : 1;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

// Scratch homes must NOT live under os.tmpdir(): on macOS that is
// /var/folders, which run-cell.sh rightly refuses. Use a repo-local scratch
// root instead so the under-$HOME path logic is what gets exercised.
const scratchRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '.docker-config-scratch',
);
after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function makeScratchHome(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, 'case-'));
  const home = path.join(scratch, 'home');
  await mkdir(home, { recursive: true });
  return home;
}

function baseEnvironment(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: home };
}

type FakeAttemptInput = { url: string; proxyUrl?: string };
type FakeAttemptOutcome =
  | { kind: 'response'; status: number }
  | { kind: 'fetch-failed'; detail: string }
  | { kind: 'probe-error'; detail: string };

const sandboxedAttempt = async (
  { url, proxyUrl }: FakeAttemptInput,
): Promise<FakeAttemptOutcome> => {
  if (proxyUrl === undefined) return { kind: 'fetch-failed', detail: 'ENETUNREACH' };
  if (url.includes('example.com')) return { kind: 'fetch-failed', detail: 'proxy 403' };
  return { kind: 'response', status: 401 };
};

test('compose isolates the runner and routes egress only through the proxy', async () => {
  const compose = parseYaml(await readFile(composePath, 'utf8')) as {
    networks: Record<string, { internal?: boolean } | null>;
    services: Record<string, {
      image?: string;
      networks?: string[];
      read_only?: boolean;
      cap_drop?: string[];
      security_opt?: string[];
      mem_limit?: unknown;
      memswap_limit?: unknown;
      pids_limit?: unknown;
      cpus?: unknown;
      environment?: Record<string, string>;
      volumes?: {
        type?: string;
        target?: string;
        source?: string;
        read_only?: boolean;
      }[];
    }>;
  };

  assert.equal(compose.networks['internal']?.internal, true);
  assert.ok('egress' in compose.networks);
  assert.notEqual((compose.networks['egress'] ?? {}).internal, true);

  const runner = compose.services['runner'];
  assert.ok(runner, 'runner service must exist');
  assert.deepEqual(runner.networks, ['internal'], 'runner joins ONLY the internal network');
  assert.equal(runner.read_only, true);
  assert.deepEqual(runner.cap_drop, ['ALL']);
  assert.ok(runner.security_opt?.includes('no-new-privileges:true'));
  assert.ok(runner.mem_limit !== undefined, 'runner must set an explicit memory limit');
  assert.ok(runner.pids_limit !== undefined, 'runner must set an explicit pids limit');
  assert.ok(runner.cpus !== undefined, 'runner must set an explicit cpu limit');
  assert.equal(runner.environment?.['NODE_USE_ENV_PROXY'], '1');
  assert.match(runner.environment?.['HTTPS_PROXY'] ?? '', /^http:\/\/proxy:\d+$/);
  assert.ok(runner.environment?.['NO_PROXY'], 'runner must set NO_PROXY');
  assert.ok(
    !JSON.stringify(compose).includes('SHAREDEVAL_MODEL_API_KEY'),
    'the model credential must never appear in compose.yaml',
  );

  const tmpfsMount = runner.volumes?.find(volume => volume.type === 'tmpfs');
  assert.equal(tmpfsMount?.target, '/tmp', 'runner must mount tmpfs at /tmp');
  const runVolume = runner.volumes?.find(volume => volume.type === 'bind');
  assert.equal(runVolume?.target, '/sharedeval-cell', 'run volume must mount at a fixed path');
  assert.equal(runVolume?.read_only, false, 'run volume must be writable');
  assert.equal(runner.volumes?.length, 2, 'runner mounts exactly the run volume and tmpfs');

  const proxy = compose.services['proxy'];
  assert.ok(proxy, 'proxy service must exist');
  assert.deepEqual([...(proxy.networks ?? [])].sort(), ['egress', 'internal']);
  assert.ok(proxy.security_opt?.includes('no-new-privileges:true'));
  const proxyConfigMount = proxy.volumes?.find(volume => volume.type === 'bind');
  assert.equal(proxyConfigMount?.read_only, true, 'proxy config mount must be read-only');
});

test('Dockerfile pins node:24-slim, lockfile install, proxy env, and SharedOS provenance', async () => {
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  assert.match(dockerfile, /^FROM node:24-slim$/m);
  assert.equal(
    (dockerfile.match(/^FROM /gm) ?? []).length,
    1,
    'single-stage build from the pinned base only',
  );
  assert.match(dockerfile, /NODE_USE_ENV_PROXY=1/);
  assert.match(dockerfile, /^RUN npm ci\b/m, 'must install from the lockfile via npm ci');
  assert.match(dockerfile, /package-lock\.json/);
  assert.match(dockerfile, /SHAREDEVAL_SHAREDOS_DIR=\/opt\/sharedos/);
  assert.match(
    dockerfile,
    /sharedos-provenance\.json/,
    'image must carry (and check) sharedos-provenance.json',
  );
  assert.match(dockerfile, /^USER node$/m, 'runner must not execute as root');
  assert.ok(
    !/^\s*(?:ENV|ARG)\s[^\n]*SHAREDEVAL_MODEL_API_KEY/m.test(dockerfile),
    'the model credential must never be baked via ENV or ARG',
  );
});

test('experiment shell scripts parse under bash -n', async () => {
  for (const scriptPath of [runCellPath, buildImagePath, egressProbeShPath]) {
    const syntax = await new Promise<ScriptResult>(resolvePromise => {
      execFile('bash', ['-n', scriptPath], (error, stdout, stderr) => {
        resolvePromise({ code: error === null ? 0 : 1, stdout, stderr });
      });
    });
    assert.equal(syntax.code, 0, `bash -n failed for ${scriptPath}: ${syntax.stderr}`);
  }
});

test('run-cell.sh refuses output dirs outside $HOME (colima bind-mount rule)', async () => {
  const home = await makeScratchHome();
  const cases: readonly { outputDir: string; expect: RegExp }[] = [
    { outputDir: '/tmp/sharedeval-cells', expect: /\/tmp and \/var\/folders/ },
    { outputDir: '/var/folders/ab/cd/T/cells', expect: /\/tmp and \/var\/folders/ },
    { outputDir: '/private/var/folders/ab/cd/T/cells', expect: /\/tmp and \/var\/folders/ },
    { outputDir: path.join(path.dirname(home), 'elsewhere'), expect: /must live under \$HOME/ },
    { outputDir: 'relative/cells', expect: /must live under \$HOME/ },
  ];
  for (const { outputDir, expect } of cases) {
    const result = await runBash(
      runCellPath,
      [
        '--config', '/nonexistent/config.yaml',
        '--run-id', 'cell-test.r1',
        '--output-dir', outputDir,
        '--image', 'sharedeval-experiment:test',
      ],
      baseEnvironment(home),
    );
    assert.notEqual(result.code, 0, `expected refusal for ${outputDir}`);
    assert.match(result.stderr, expect, `stderr for ${outputDir}: ${result.stderr}`);
  }
});

test('run-cell.sh refuses plain-http model endpoints before touching docker', async () => {
  const home = await makeScratchHome();
  const configPath = path.join(home, 'plain-http.yaml');
  await writeFile(configPath, plainHttpConfig, 'utf8');
  const result = await runBash(
    runCellPath,
    [
      '--config', configPath,
      '--run-id', 'cell-test.r1',
      '--output-dir', path.join(home, 'cells'),
      '--image', 'sharedeval-experiment:test',
    ],
    baseEnvironment(home),
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /plain HTTP model endpoints are refused/);
});

test('run-cell.sh refuses invalid run ids before doing any work', async () => {
  const home = await makeScratchHome();
  const result = await runBash(
    runCellPath,
    [
      '--config', '/nonexistent/config.yaml',
      '--run-id', '-bad/run/id',
      '--output-dir', path.join(home, 'cells'),
      '--image', 'sharedeval-experiment:test',
    ],
    baseEnvironment(home),
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not a valid Sharedeval run id/);
});

test('deriveCellEndpointV1 derives the allowlist host from the config only', () => {
  const derived = deriveCellEndpointV1(httpsConfig);
  assert.equal(derived.endpointHost, 'openrouter.ai');
  assert.equal(derived.endpointPort, 443);
  assert.equal(derived.mode, 'multi');
  assert.equal(derived.provider, 'openai-compatible');
  assert.equal(derived.outputDirectory, 'runs');

  const azureConfig = httpsConfig
    .replace('provider: openai-compatible', 'provider: azure-openai')
    .replace(
      'baseUrl: https://openrouter.ai/api/v1',
      'endpoint: https://example-resource.openai.azure.com/openai/v1',
    );
  assert.equal(
    deriveCellEndpointV1(azureConfig).endpointHost,
    'example-resource.openai.azure.com',
  );

  const defaultedOutput = httpsConfig.replace(/output:[\s\S]*$/, '');
  assert.equal(deriveCellEndpointV1(defaultedOutput).outputDirectory, 'runs');
});

test('deriveCellEndpointV1 fails closed on endpoints the sandbox cannot hold', () => {
  assert.throws(() => deriveCellEndpointV1(plainHttpConfig), /plain HTTP/);
  assert.throws(
    () => deriveCellEndpointV1(
      httpsConfig.replace('https://openrouter.ai/api/v1', 'http://localhost:8080/v1'),
    ),
    /loopback/,
  );
  assert.throws(
    () => deriveCellEndpointV1(
      httpsConfig.replace('https://openrouter.ai/api/v1', 'https://127.0.0.1/v1'),
    ),
    /loopback/,
  );
  assert.throws(
    () => deriveCellEndpointV1(
      httpsConfig.replace('https://openrouter.ai/api/v1', 'https://openrouter.ai:8443/v1'),
    ),
    /443/,
  );
  assert.throws(
    () => deriveCellEndpointV1(httpsConfig.replace('directory: runs', 'directory: ../runs')),
    /safe relative path/,
  );
  assert.throws(
    () => deriveCellEndpointV1(httpsConfig.replace('directory: runs', 'directory: /runs')),
    /safe relative path/,
  );
  assert.throws(
    () => deriveCellEndpointV1(httpsConfig.replace('mode: multi', 'mode: batch')),
    /multi or single/,
  );
});

test('tinyproxy config is CONNECT-only with a single exact-host allowlist', () => {
  const config = tinyproxyConfigV1() as string;
  assert.match(config, /^Port 8888$/m);
  assert.match(config, /^ConnectPort 443$/m);
  assert.match(config, /^FilterDefaultDeny Yes$/m);
  assert.match(config, /^FilterType fnmatch$/m);
  assert.match(config, /^Filter "\/etc\/sharedeval-proxy\/allowlist"$/m);
  assert.equal(tinyproxyAllowlistV1('openrouter.ai'), 'openrouter.ai\n');
  assert.throws(() => tinyproxyAllowlistV1('*.openrouter.ai'), /invalid/);
  assert.throws(() => tinyproxyAllowlistV1('openrouter.ai/path'), /invalid/);
});

test('cell provenance records image digest, allowlist, probe, and exit code', () => {
  const probe = {
    directEgressBlocked: true,
    nonAllowlistedEgressBlocked: true,
    modelEndpointReachable: true,
    pass: true,
  };
  const provenance = buildCellProvenanceV1({
    runId: 'exp-a.abcdef.r1',
    imageRef: 'sharedeval-experiment:abc',
    imageId: `sha256:${'a'.repeat(64)}`,
    allowlistedEgress: ['openrouter.ai:443'],
    configDigest: 'b'.repeat(64),
    probe,
    probeExitCode: 0,
    cliExitCode: 0,
    runRoot: '/home/user/cells/exp-a.abcdef.r1/runs/exp-a.abcdef.r1',
    startedAt: '2026-08-27T00:00:00Z',
    finishedAt: '2026-08-27T00:10:00Z',
  });
  assert.equal(provenance.apiVersion, 'sharedeval-cell-provenance/v1');
  assert.equal(provenance.imageDigest, `sha256:${'a'.repeat(64)}`);
  assert.deepEqual(provenance.egressProbe, {
    directEgressBlocked: true,
    nonAllowlistedEgressBlocked: true,
    modelEndpointReachable: true,
  });
  assert.equal(provenance.cliExitCode, 0);

  // Probe-refused cell: no CLI exit code, probe report still recorded.
  const refused = buildCellProvenanceV1({
    runId: 'exp-a.abcdef.r1',
    imageRef: 'sharedeval-experiment:abc',
    imageId: `sha256:${'a'.repeat(64)}`,
    allowlistedEgress: ['openrouter.ai:443'],
    probe: { ...probe, modelEndpointReachable: false, pass: false },
    probeExitCode: 1,
    runRoot: '/home/user/cells/exp-a.abcdef.r1/runs/exp-a.abcdef.r1',
    startedAt: '2026-08-27T00:00:00Z',
    finishedAt: '2026-08-27T00:01:00Z',
  });
  assert.equal(refused.cliExitCode, null);
  assert.equal(refused.egressProbe?.modelEndpointReachable, false);

  assert.throws(
    () => buildCellProvenanceV1({
      runId: 'x',
      imageRef: 'ref',
      imageId: 'not-a-digest',
      allowlistedEgress: ['openrouter.ai:443'],
      probeExitCode: 0,
      runRoot: '/r',
      startedAt: 't',
      finishedAt: 't',
    }),
    /sha256/,
  );
  assert.throws(
    () => buildCellProvenanceV1({
      runId: 'x',
      imageRef: 'ref',
      imageId: `sha256:${'a'.repeat(64)}`,
      allowlistedEgress: ['openrouter.ai:8443'],
      probeExitCode: 0,
      runRoot: '/r',
      startedAt: 't',
      finishedAt: 't',
    }),
    /host:443/,
  );
});

test('egress probe passes only when all three sandbox checks hold', async () => {
  const report = await runEgressProbeV1({
    endpointHost: 'openrouter.ai',
    proxyUrl: 'http://proxy:8888',
    attempt: sandboxedAttempt,
    endpointAttempts: 1,
    sleep: async () => {},
  });
  assert.equal(report.apiVersion, 'sharedeval-egress-probe/v1');
  assert.equal(report.directEgressBlocked, true);
  assert.equal(report.nonAllowlistedEgressBlocked, true);
  assert.equal(report.modelEndpointReachable, true);
  assert.equal(report.pass, true);
  assert.equal(report.checks.length, 3);

  const leakyDirect = async (
    { proxyUrl }: FakeAttemptInput,
  ): Promise<FakeAttemptOutcome> => (
    proxyUrl === undefined
      ? { kind: 'response', status: 200 }
      : { kind: 'response', status: 200 }
  );
  const leakyReport = await runEgressProbeV1({
    endpointHost: 'openrouter.ai',
    proxyUrl: 'http://proxy:8888',
    attempt: leakyDirect,
    endpointAttempts: 1,
    sleep: async () => {},
  });
  assert.equal(leakyReport.directEgressBlocked, false);
  assert.equal(leakyReport.pass, false);

  const brokenProbe = async (): Promise<FakeAttemptOutcome> => (
    { kind: 'probe-error', detail: 'spawn failed' }
  );
  const brokenReport = await runEgressProbeV1({
    endpointHost: 'openrouter.ai',
    proxyUrl: 'http://proxy:8888',
    attempt: brokenProbe,
    endpointAttempts: 1,
    sleep: async () => {},
  });
  assert.equal(brokenReport.pass, false, 'a malfunctioning probe must fail closed');
  assert.equal(brokenReport.directEgressBlocked, false);
});

test('egress probe retries the endpoint check while the proxy starts up', async () => {
  let endpointCalls = 0;
  let sleeps = 0;
  const slowProxyAttempt = async (
    { url, proxyUrl }: FakeAttemptInput,
  ): Promise<FakeAttemptOutcome> => {
    if (proxyUrl === undefined) return { kind: 'fetch-failed', detail: 'ENETUNREACH' };
    if (url.includes('example.com')) return { kind: 'fetch-failed', detail: 'proxy 403' };
    endpointCalls += 1;
    return endpointCalls < 3
      ? { kind: 'fetch-failed', detail: 'ECONNREFUSED' }
      : { kind: 'response', status: 200 };
  };
  const report = await runEgressProbeV1({
    endpointHost: 'openrouter.ai',
    proxyUrl: 'http://proxy:8888',
    attempt: slowProxyAttempt,
    endpointAttempts: 5,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(report.pass, true);
  assert.equal(endpointCalls, 3);
  assert.equal(sleeps, 2);
  await assert.rejects(
    runEgressProbeV1({
      endpointHost: 'example.com',
      proxyUrl: 'http://proxy:8888',
      attempt: slowProxyAttempt,
      endpointAttempts: 1,
      sleep: async () => {},
    }),
    /must differ/,
  );
});
