import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialRedactionStream } from './acceptance-stream-redaction.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lines = createInterface({ input: process.stdin, terminal: false });
let key;
let active;
let chain = Promise.resolve();
const print = value => process.stdout.write(`${sanitize(JSON.stringify(value))}\n`);
const sanitize = value => String(value).replaceAll(key ?? '__no_credential__', '[REDACTED]')
  .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED]');

async function execute(command) {
  if (command.kind === 'check-key') {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    const data = await response.json();
    print({ event: 'credential_check', status: response.status, valid: response.ok,
      limit: data.data?.limit, limitRemaining: data.data?.limit_remaining,
      usage: data.data?.usage, isFreeTier: data.data?.is_free_tier,
      ...(response.ok ? {} : { error: sanitize(data.error?.message ?? 'rejected') }) });
    return;
  }
  if (command.kind === 'run') {
    if (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) {
      throw new Error('invalid_run_arguments');
    }
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR',
      'SHAREDEVAL_SHAREDOS_DIR', 'SHAREDEVAL_REQUIRE_SHAREDOS'].flatMap(name => (
      process.env[name] === undefined ? [] : [[name, process.env[name]]]
    )));
    env.SHAREDEVAL_MODEL_API_KEY = key;
    const child = spawn(process.execPath, ['--import', 'tsx',
      'scripts/experiments/run-pair-acceptance.ts', ...command.args], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    active = child;
    print({ event: 'run_started', pid: child.pid, args: command.args });
    child.stdout.pipe(createCredentialRedactionStream()).pipe(process.stdout, { end: false });
    child.stderr.pipe(createCredentialRedactionStream()).pipe(process.stderr, { end: false });
    const result = await new Promise(resolveResult => {
      child.once('error', error => resolveResult({ error: sanitize(error.message) }));
      child.once('close', (code, signal) => resolveResult({ code, signal }));
    });
    active = undefined;
    print({ event: 'run_finished', ...result });
    return;
  }
  if (command.kind === 'close') {
    key = undefined;
    lines.close();
    process.stdin.destroy();
    return;
  }
  throw new Error('unknown_command');
}

lines.on('line', line => {
  if (key === undefined) {
    if (!/^sk-or-v1-[A-Za-z0-9_-]+$/.test(line.trim())) {
      print({ event: 'invalid_credential_format' });
      return;
    }
    key = line.trim();
    print({ event: 'credential_loaded_in_memory' });
    return;
  }
  chain = chain.then(() => execute(JSON.parse(line))).catch(error => {
    print({ event: 'host_error', error: sanitize(error.message) });
  });
});
process.on('SIGTERM', () => {
  active?.kill('SIGTERM');
  key = undefined;
  lines.close();
  process.stdin.destroy();
});
print({ event: 'awaiting_credential_on_stdin' });
