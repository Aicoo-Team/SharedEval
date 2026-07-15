import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parsePactSubmissionResponseLineV1,
  isPactErrorResponseV1,
  serializePactWireMessageV1,
  type PactAdapterMethodV1,
  type PactResponseForMethodV1,
  type PactRunnerRequestV1,
} from '../../protocol/v1/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const entrypoint = join(
  repoRoot,
  'examples',
  'submissions',
  'typescript-basic',
  'src',
  'main.ts',
);

const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
  cwd: repoRoot,
  env: { ...process.env, FORCE_COLOR: '0' },
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
const lines = createInterface({
  input: child.stdout,
  crlfDelay: Number.POSITIVE_INFINITY,
  terminal: false,
})[Symbol.asyncIterator]();
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderr += String(chunk);
});

async function roundTrip<R extends PactRunnerRequestV1>(
  request: R,
): Promise<PactResponseForMethodV1<R['method']>> {
  child.stdin.write(serializePactWireMessageV1(request));
  const next = await withTimeout(lines.next(), 5_000, `response to ${request.method}`);
  if (next.done) {
    throw new Error(`Sample exited before ${request.method} responded. ${stderr}`);
  }
  return parsePactSubmissionResponseLineV1(next.value, {
    id: request.id,
    method: request.method,
  });
}

try {
  const initialized = await roundTrip({
    jsonrpc: '2.0',
    id: 'smoke-initialize',
    method: 'pact.initialize',
    params: {
      protocolVersion: 'pact-adapter/v1',
      sessionId: 'sample-smoke-session',
      benchmark: {
        track: 'pact-pair',
        mode: 'pair-responder',
        version: 'public-smoke',
      },
      budget: { maxTurns: 4, maxToolCalls: 1, maxRuntimeMs: 30_000 },
      tools: [
        {
          name: 'search_notes',
          description: 'Search notes inside the granted boundary.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          sideEffects: 'read',
        },
      ],
    },
  });
  assert.ok(!('error' in initialized));

  const task = {
    taskId: 'PAIR-SMOKE-001',
    kind: 'qa' as const,
    prompt: 'What is the public launch month?',
    requester: { id: 'requester-smoke', relationship: 'colleague' },
    target: { id: 'target-smoke' },
    surface: 'notes' as const,
  };
  const planned = await roundTrip({
    jsonrpc: '2.0',
    id: 'smoke-plan',
    method: 'pact.planBoundary',
    params: { task },
  });
  assert.ok(!('error' in planned));
  if (isPactErrorResponseV1(planned)) throw new Error(planned.error.message);

  const stepped = await roundTrip({
    jsonrpc: '2.0',
    id: 'smoke-step-task',
    method: 'pact.step',
    params: {
      observation: {
        type: 'task',
        turn: 0,
        task,
        grantedAccess: planned.result.plan,
        budgetRemaining: { turns: 4, toolCalls: 1, runtimeMs: 30_000 },
      },
    },
  });
  assert.ok(!('error' in stepped));
  if (isPactErrorResponseV1(stepped)) throw new Error(stepped.error.message);
  assert.equal(stepped.result.decision.type, 'tool_call');

  const answered = await roundTrip({
    jsonrpc: '2.0',
    id: 'smoke-step-result',
    method: 'pact.step',
    params: {
      observation: {
        type: 'tool_result',
        turn: 1,
        toolCallId: 'tool-call-smoke-1',
        toolName: 'search_notes',
        output: { matches: [{ title: 'Launch', content: 'September' }] },
        isError: false,
        budgetRemaining: { turns: 3, toolCalls: 0, runtimeMs: 29_000 },
      },
    },
  });
  assert.ok(!('error' in answered));
  if (isPactErrorResponseV1(answered)) throw new Error(answered.error.message);
  assert.equal(answered.result.decision.type, 'answer');

  const finalized = await roundTrip({
    jsonrpc: '2.0',
    id: 'smoke-finalize',
    method: 'pact.finalize',
    params: { reason: 'completed' },
  });
  assert.ok(!('error' in finalized));

  child.stdin.end();
  const [code, signal] = await withTimeout(exited, 5_000, 'sample process exit');
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  console.log('PACT TypeScript sample smoke passed (initialize -> tool call -> answer -> finalize)');
} catch (error) {
  child.kill('SIGKILL');
  throw error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
