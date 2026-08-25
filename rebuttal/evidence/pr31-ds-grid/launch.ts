import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPr31SanitizedConfig,
  loadAndValidatePr31Evidence,
} from './schema.js';
import { inspectPactBenchmarkV1 } from '../../../src/runner/v1/runner.js';

type Mode = 'check' | 'run';

type Options =
  | { list: true; mode?: never; configId?: never; repoRoot: string; sharedOsDir: string }
  | { list: false; mode: Mode; configId: string; repoRoot: string; sharedOsDir: string };

const evidenceRoot = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(evidenceRoot, '../../..');

class UsageError extends Error {}

function parseArguments(args: string[]): Options {
  let list = false;
  let mode: Mode | undefined;
  let configId: string | undefined;
  let repoRoot = defaultRepositoryRoot;
  let sharedOsDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--list') {
      list = true;
      continue;
    }
    if (
      argument === '--mode'
      || argument === '--config'
      || argument === '--repo-root'
      || argument === '--sharedos-dir'
    ) {
      const value = args[index + 1];
      if (!value) throw new UsageError('missing option value');
      if (argument === '--mode') {
        if (value !== 'check' && value !== 'run') {
          throw new UsageError('invalid mode');
        }
        mode = value;
      } else if (argument === '--config') {
        configId = value;
      } else if (argument === '--repo-root') {
        repoRoot = resolve(value);
      } else {
        sharedOsDir = resolve(value);
      }
      index += 1;
      continue;
    }
    throw new UsageError('unknown option');
  }

  const resolvedSharedOsDir = sharedOsDir ?? resolve(repoRoot, '..', 'SharedOS');
  if (list) {
    if (mode || configId) throw new UsageError('list cannot be combined with a mode');
    return {
      list: true,
      repoRoot,
      sharedOsDir: resolvedSharedOsDir,
    };
  }
  if (!mode || !configId) {
    throw new UsageError('choose --list or provide --mode and --config');
  }
  if (!/^[A-Za-z0-9_]+$/.test(configId)) {
    throw new UsageError('invalid config id');
  }
  return {
    list: false,
    mode,
    configId,
    repoRoot,
    sharedOsDir: resolvedSharedOsDir,
  };
}

function usageFailure(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function executeRun(
  repoRoot: string,
  sharedOsDir: string,
  config: ReturnType<typeof buildPr31SanitizedConfig>,
): number {
  const temporary = mkdtempSync(join(tmpdir(), 'pact-pr31-config-'));
  try {
    const configPath = join(temporary, 'pact-run.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const child = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
        resolve(repoRoot, 'src/runner/v1/cli.ts'),
        '--config',
        configPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PACT_SHAREDOS_DIR: sharedOsDir,
        },
        stdio: 'inherit',
      },
    );
    return child.status ?? 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

let options: Options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  usageFailure(
    error instanceof UsageError && error.message.includes('choose')
      ? 'Choose --list or provide --mode and --config.'
      : 'Invalid launcher arguments.',
  );
}

let evidence: ReturnType<typeof loadAndValidatePr31Evidence>;
try {
  evidence = loadAndValidatePr31Evidence(
    resolve(evidenceRoot, 'manifest.json'),
    resolve(evidenceRoot, 'aggregates.json'),
  );
} catch {
  usageFailure('Historical evidence validation failed.');
}

if (options.list) {
  const listed = evidence.manifest.configurations
    .filter(row => row.disposition === 'executable-current-main')
    .map(row => ({
      id: row.id,
      policy: row.policy,
      requester: row.requester,
      taskCount: row.taskCount,
    }));
  process.stdout.write(`${JSON.stringify(listed)}\n`);
} else {
  const row = evidence.manifest.configurations.find(
    candidate => candidate.id === options.configId,
  );
  if (!row) usageFailure('Unknown configuration.');
  if (row.disposition === 'historical-only') {
    usageFailure(
      `Configuration is historical-only: policy ${row.policy} is unsupported.`,
    );
  }
  const config = buildPr31SanitizedConfig(row);
  if (options.mode === 'check') {
    const inspected = inspectPactBenchmarkV1(config);
    process.stdout.write(`${JSON.stringify({
      config: row.id,
      mode: 'check',
      taskCount: inspected.taskCount,
    })}\n`);
  } else {
    if (!process.env.PACT_MODEL_API_KEY?.trim()) {
      usageFailure('PACT_MODEL_API_KEY must be set for run mode.');
    }
    process.exitCode = executeRun(
      options.repoRoot,
      options.sharedOsDir,
      config,
    );
  }
}
