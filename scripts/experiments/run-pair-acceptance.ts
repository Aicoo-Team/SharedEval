import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { mainSharedevalV1 } from '../../src/runner/v1/sharedeval-cli.js';
import { runSharedevalProductionV1 } from '../../src/runner/v1/sharedeval-production.js';
import { createOpenAICompatibleFileTurnDriverV1 } from '../../src/runner/v1/file-model-driver.js';
import type { NativeCodexCloseContext } from './codex-app-server-transport.js';

const zip = promisify(gzip);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing_${name}`);
  argv.splice(index, 2);
  return value;
}
const harness = flag('--harness', 'deepseek');
const projection = flag('--projection', 'raw');
const maxCostUsd = Number(flag('--max-cost-usd', '25'));
if (!['deepseek', 'codex'].includes(harness)
  || !['raw', 'deduplicate'].includes(projection)
  || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error('invalid_acceptance_options');

const key = process.env.SHAREDEVAL_MODEL_API_KEY ?? '';
const redact = (value: string) => (key ? value.replaceAll(key, '[REDACTED]') : value)
  .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED]');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const log = (value: unknown) => process.stdout.write(`${redact(JSON.stringify(value))}\n`);
async function json(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${redact(JSON.stringify(value, null, 2))}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
async function captureResponse(response: Response): Promise<{ response: Response; text: string }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          void reader.cancel().catch(() => {});
          throw new Error('acceptance_provider_response_exceeds_2mib');
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = Buffer.concat(chunks);
  return { text: body.toString('utf8'), response: new Response(
    [204, 205, 304].includes(response.status) ? null : body,
    { status: response.status, statusText: response.statusText, headers: response.headers },
  ) };
}
const closers = new Set<() => Promise<void>>();
const startedAt = new Date().toISOString();
let runRoot: string | undefined;
let lastProgress = '';
let serial = 0;
let driverSerial = 0;
let observedCostUsd = 0;
let reservedCostUsd = 0;
let unreconciledCostReserveUsd = 0;
let promptTokens = 0;
let completionTokens = 0;
let missingUsage = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let failed = false;

async function progress() {
  if (!runRoot) return;
  let tickCount = 0;
  let lastTick: unknown;
  try {
    const contents = await readFile(join(runRoot, 'multi', 'ticks.jsonl'), 'utf8');
    const lines = contents.trim().split('\n').filter(Boolean);
    tickCount = lines.length;
    const last = JSON.parse(lines.at(-1) ?? '{}');
    lastTick = { tick: last.tick, taskId: last.selectedTaskId, contactStatus: last.contactStatus };
  } catch { /* No committed ticks yet. */ }
  const state = { event: 'progress', harness, projection, startedAt,
    at: new Date().toISOString(), requests: serial, tickCount, lastTick,
    observedCostUsd: harness === 'codex' ? null : observedCostUsd,
    reservedCostUsd, unreconciledCostReserveUsd,
    promptTokens: harness === 'codex' ? null : promptTokens,
    completionTokens: harness === 'codex' ? null : completionTokens, missingUsage,
    ...(harness === 'codex' ? { nativeUsageSource: 'private-provider/*.native.json',
      requestCountDefinition: 'bridge exchanges, not native model calls' } : {}) };
  await json(join(runRoot, 'acceptance-progress.json'), state);
  const stamp = `${serial}/${tickCount}/${observedCostUsd}`;
  if (stamp !== lastProgress) { log(state); lastProgress = stamp; }
}

try {
  process.exitCode = await mainSharedevalV1(argv, {
    runProduction: async options => {
      const outputRoot = join(options.configRootDir, options.config.output.directory);
      const candidateRunRoot = join(outputRoot, options.runId);
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      // A live acceptance never resumes unknown effects or overwrites old evidence.
      await mkdir(candidateRunRoot, { mode: 0o700 });
      runRoot = candidateRunRoot;
      const evidenceRoot = join(runRoot, 'private-provider');
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      const overlay: Record<string, string> = {};
      for (const name of ['run-pair-acceptance.ts', 'acceptance-context-projection.ts',
        'codex-app-server-transport.ts']) {
        try { overlay[name] = hash(await readFile(join(root, 'scripts/experiments', name), 'utf8')); }
        catch { /* Optional adapter is not used by this harness. */ }
      }
      await json(join(runRoot, 'acceptance-manifest.json'), {
        protocol: 'pair-live-acceptance/v1', harness, projection, startedAt,
        overlaySha256: overlay, configDigest: options.config.configDigest,
        taskIds: options.config.benchmark.tasks.ids,
        maxTicks: options.config.workflow.maxTicks, maxCostUsd,
        rawJournalsRetained: true,
        evidencePrivate: true,
        ...(harness === 'codex' ? {
          boundary: 'native Codex app-server through an experimental chat-completions-shaped transport',
          httpModelVerificationNotApplicable: true,
          requestCountDefinition: 'bridge exchanges, not native model calls',
          billingNotAvailable: true, nativeUsageSource: 'private-provider/*.native.json',
        } : {}),
      });
      timer = setInterval(() => { void progress().catch(() => {}); }, 15000);
      const projectorFactory = projection === 'deduplicate'
        ? (await import('./acceptance-context-projection.js')).createAcceptanceTurnContextProjector
        : undefined;
      log({ event: 'acceptance_start', harness, projection, runRoot,
        tasks: options.config.benchmark.tasks.ids?.length, maxTicks: options.config.workflow.maxTicks });
      return runSharedevalProductionV1(options, {
        createDriver: driverOptions => {
          const driverId = ++driverSerial;
          const actorId = driverOptions.actorContext?.actorId ?? 'unknown';
          const project = projectorFactory?.();
          let native: Awaited<ReturnType<typeof import('./codex-app-server-transport.js')['createCodexAppServerTransport']>> | undefined;
          let runtimeTurnTimeoutMs: number | undefined;
          const closeNative = async (context: NativeCodexCloseContext = { source: 'run_cleanup' }) => {
            try { await native?.close(context); }
            finally { native = undefined; closers.delete(closeNative); }
          };
          const fetchImplementation: typeof fetch = async (input, init) => {
            const requestId = ++serial;
            const begin = Date.now();
            const rawBody = String(init?.body ?? '');
            const body = JSON.parse(rawBody);
            const result = project?.(body.messages);
            if (result) body.messages = result.messages;
            const requestBody = JSON.stringify(body);
            const prefix = `${String(requestId).padStart(6, '0')}-${actorId}-${driverId}`;
            const requestPath = join(evidenceRoot, `${prefix}.request.json.gz`);
            await writeFile(requestPath, await zip(redact(JSON.stringify({
              at: new Date().toISOString(), actorId, driverId, requestId,
              rawMessagesSha256: hash(JSON.stringify(JSON.parse(rawBody).messages)),
              projectedMessagesSha256: hash(JSON.stringify(body.messages)),
              rawBodyBytes: Buffer.byteLength(rawBody), bodyBytes: Buffer.byteLength(requestBody),
              projection: result?.metadata ?? { protocol: 'raw' }, body,
            }))), { mode: 0o600 });
            log({ event: 'provider_request', harness, actorId, requestId,
              messages: body.messages.length, rawBytes: Buffer.byteLength(rawBody),
              projectedBytes: Buffer.byteLength(requestBody) });
            let response: Response;
            let requestReserve = 0;
            if (harness === 'deepseek') {
              const target = new URL(String(input));
              if (target.origin !== 'https://openrouter.ai'
                || target.pathname !== '/api/v1/chat/completions') throw new Error('unexpected_provider_target');
              if (body.model !== 'deepseek/deepseek-v4-flash-0731'
                || body.provider?.allow_fallbacks !== false
                || JSON.stringify(body.provider?.only) !== '["Inceptron"]') {
                throw new Error('acceptance_cost_route_not_fixed');
              }
              // Conservative bytes-as-tokens reserve for the fixed Inceptron route.
              const reserve = Buffer.byteLength(requestBody) * 0.0000001
                + Number(body.max_tokens ?? 4096) * 0.0000003;
              if (observedCostUsd + unreconciledCostReserveUsd + reserve > maxCostUsd) {
                throw new Error('acceptance_cost_reserve_exhausted');
              }
              reservedCostUsd += reserve;
              unreconciledCostReserveUsd += reserve;
              requestReserve = reserve;
              response = await fetch(input, { ...init, body: requestBody, redirect: 'error' });
            } else {
              if (!native) {
                const module = await import('./codex-app-server-transport.js');
                native = await module.createCodexAppServerTransport({
                  model: body.model, actorId, evidenceDirectory: evidenceRoot, effort: 'medium',
                  runtimeTurnTimeoutMs,
                });
                closers.add(closeNative);
              }
              response = await native.fetch(input, { ...init, body: requestBody });
            }
            const captured = await captureResponse(response);
            response = captured.response;
            const responseText = redact(captured.text);
            let parsed: Record<string, any> = {};
            let evidenceBody: unknown = responseText;
            try { parsed = JSON.parse(responseText); evidenceBody = parsed; } catch { /* Retain bounded text evidence. */ }
            const usage = parsed.usage;
            if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
              observedCostUsd += usage.cost;
              unreconciledCostReserveUsd = Math.max(0, unreconciledCostReserveUsd - requestReserve);
            }
            if (typeof usage?.prompt_tokens === 'number') promptTokens += usage.prompt_tokens;
            else missingUsage += 1;
            if (typeof usage?.completion_tokens === 'number') completionTokens += usage.completion_tokens;
            await json(join(evidenceRoot, `${prefix}.response.json`), {
              at: new Date().toISOString(), actorId, driverId, requestId,
              status: response.status, latencyMs: Date.now() - begin,
              body: evidenceBody,
            });
            log({ event: 'provider_response', harness, actorId, requestId,
              status: response.status, model: parsed.model, provider: parsed.provider,
              latencyMs: Date.now() - begin, usage });
            return response;
          };
          const driver = createOpenAICompatibleFileTurnDriverV1({ ...driverOptions,
            fetch: fetchImplementation,
            ...(harness === 'codex' ? { servedModelLedger: undefined } : {}),
          });
          if (harness !== 'codex') return driver;
          return {
            getFileProviderTelemetryV1: () => driver.getFileProviderTelemetryV1(),
            assertActorContextSettled: () => driver.assertActorContextSettled(),
            open: async (request, signal) => {
              runtimeTurnTimeoutMs = request.options?.timeoutMs;
              const session = await driver.open(request, signal);
              return {
                next: (input, signal) => session.next(input, signal),
                close: async (outcome, closeSignal) => {
                  let actorSettlement: 'succeeded' | 'failed' = 'failed';
                  try { await session.close?.(outcome, closeSignal); actorSettlement = 'succeeded'; }
                  finally {
                    try { await closeNative({ source: 'session_close', executionId: request.executionId,
                      outcome, actorSettlement, runtimeSignalAborted: signal.aborted }); }
                    catch (cleanupError) {
                      // Do not replace the original settlement error with a later cleanup error.
                      if (actorSettlement === 'succeeded') throw cleanupError;
                    }
                  }
                },
              };
            },
          };
        },
      });
    },
    writeOutput: source => process.stdout.write(redact(source)),
  });
} catch (error) {
  failed = true;
  process.exitCode = 1;
  log({ event: 'acceptance_failed', error: redact(error instanceof Error ? error.message : String(error)) });
} finally {
  if (timer) clearInterval(timer);
  for (const close of closers) await close().catch(() => {});
  if (runRoot) {
    await progress().catch(() => {});
    await json(join(runRoot, 'acceptance-outcome.json'), {
      harness, projection, startedAt, finishedAt: new Date().toISOString(),
      executionReturned: !failed, exitCode: process.exitCode ?? 0,
      requests: serial, observedCostUsd: harness === 'codex' ? null : observedCostUsd,
      reservedCostUsd, unreconciledCostReserveUsd,
      promptTokens: harness === 'codex' ? null : promptTokens,
      completionTokens: harness === 'codex' ? null : completionTokens, missingUsage,
      ...(harness === 'codex' ? { nativeUsageSource: 'private-provider/*.native.json',
        requestCountDefinition: 'bridge exchanges, not native model calls' } : {}),
      note: 'Execution return is not task completion or trajectory safety; inspect committed records.',
    });
  }
}
