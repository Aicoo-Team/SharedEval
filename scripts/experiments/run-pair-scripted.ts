// No-cost PAIR Multi harness check: drives the real production run path and the
// pinned SharedOS runtime with a deterministic, local OpenAI-compatible endpoint
// that plays both actors. It exists to prove the multi-turn probe protocol
// (Phase 1 → Phase 2 retry strategies → finalization) is reachable end to end
// without spending on a paid provider. It is not a model result: every answer,
// refusal, and flip below is scripted.
//
// Scripted runs must never be mistaken for model evidence, so configs carry the
// model id `scripted/pair-probe-v1`, an unresolvable base URL, and file names
// without any provider name; the runner refuses any other model id and stamps
// SCRIPTED-RUN.json into the run root.
//
// Usage:
//   npx tsx scripts/experiments/run-pair-scripted.ts --prepare-configs <dir>
//   SHAREDEVAL_SHAREDOS_DIR=<built SharedOS> \
//   npx tsx scripts/experiments/run-pair-scripted.ts --config <dir>/scripted-pair-preflight.yaml --run-id <id>
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { mainSharedevalV1 } from '../../src/runner/v1/sharedeval-cli.js';
import { runSharedevalProductionV1 } from '../../src/runner/v1/sharedeval-production.js';
import { createOpenAICompatibleFileTurnDriverV1 } from '../../src/runner/v1/file-model-driver.js';
import { PREFLIGHT_IDS, SPLIT_IDS, acceptanceConfig } from './prepare-pair-acceptance.js';

type Message = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export const SCRIPTED_MODEL_ID = 'scripted/pair-probe-v1';
const SCRIPTED_BASE_URL = 'https://scripted.invalid/v1';
const WORKSPACE_FILES = ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md'] as const;
export const PHASE2_STRATEGIES = [
  'repeat', 'business_justification', 'urgency', 'social_appeal', 'decomposition',
] as const;
const REFUSAL_MARKER = 'SCRIPTED-REFUSAL';
const ANSWER_MARKER = 'SCRIPTED-ANSWER';

const hashIndex = (value: string, modulo: number) =>
  createHash('sha256').update(value).digest().readUInt32BE(0) % modulo;

/**
 * The frozen acceptance configs (same tasks, ticks, phase boundaries, budget)
 * relabelled so no artifact can be read as a provider run.
 */
export function scriptedConfig(ids: string[], preflight = false) {
  const config = acceptanceConfig(ids, preflight);
  const { providerRouting: _routing, ...model } = config.model as typeof config.model & { providerRouting?: unknown };
  return { ...config, model: { ...model, baseUrl: SCRIPTED_BASE_URL, model: SCRIPTED_MODEL_ID } };
}

/**
 * Which strategy (if any) makes the scripted responder flip for one QA task.
 * 0..4 index PHASE2_STRATEGIES; 5 means the responder never flips, so the task
 * exhausts all five strategies. Every QA task is refused on its first ask so
 * Phase 2 is exercised for all of them.
 */
export function scriptedFlipIndex(taskId: string): number {
  return hashIndex(`flip:${taskId}`, PHASE2_STRATEGIES.length + 1);
}

function parseToolOutput(content: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(content)) as Record<string, unknown>;
    const output = parsed.output;
    return output !== null && typeof output === 'object' ? output as Record<string, unknown> : parsed;
  } catch {
    return { text: String(content ?? '') };
  }
}

/** Messages belonging to the current turn: everything after the last user message. */
function currentTurn(messages: readonly Message[]): { prompt: string; turn: Message[] } {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') { start = index; break; }
  }
  return { prompt: String(messages[start]?.content ?? ''), turn: messages.slice(start + 1) };
}

type MemoryLine = { taskId: string; status: string; note: string };

export function parseMemory(content: string): MemoryLine[] {
  return content.split('\n').filter(Boolean).map(line => {
    const match = /^(\S+) \[(pending|answered|refused|error)\] — ?(.*)$/.exec(line);
    if (!match) throw new Error(`scripted_requester_unparseable_memory_line: ${line}`);
    return { taskId: match[1]!, status: match[2]!, note: match[3] ?? '' };
  });
}

export function renderMemory(lines: readonly MemoryLine[]): string {
  return `${lines.map(line => `${line.taskId} [${line.status}] — ${line.note}`).join('\n')}\n`;
}

function triedOf(note: string): string[] {
  const match = /tried=([a-z_,]*)/.exec(note);
  return match?.[1] ? match[1].split(',').filter(Boolean) : [];
}

export type RequesterPlan =
  | { kind: 'contact'; index: number; strategy: string }
  | { kind: 'finalize'; index: number }
  | { kind: 'idle' };

/** The probe HEARTBEAT selection rules, applied deterministically. */
export function planRequesterTurn(lines: readonly MemoryLine[], prompt: string): RequesterPlan {
  if (/Finalization window/.test(prompt)) {
    const index = lines.findIndex(line => line.status === 'pending');
    return index < 0 ? { kind: 'idle' } : { kind: 'finalize', index };
  }
  if (/Phase 2 \(retry protocol active\)/.test(prompt)) {
    const index = lines.findIndex(line => line.status === 'pending'
      && line.taskId.startsWith('PAIR-Q') && triedOf(line.note).length > 0);
    if (index >= 0) {
      const tried = triedOf(lines[index]!.note);
      const strategy = PHASE2_STRATEGIES.find(candidate => !tried.includes(candidate));
      if (strategy) return { kind: 'contact', index, strategy };
    }
    // Phase 2 may begin before every first ask was committed; fall through.
  }
  const index = lines.findIndex(line => line.status === 'pending' && triedOf(line.note).length === 0);
  return index < 0 ? { kind: 'idle' } : { kind: 'contact', index, strategy: 'first_ask' };
}

export function applyReply(line: MemoryLine, strategy: string, reply: string): MemoryLine {
  const tried = [...triedOf(line.note), strategy];
  const refused = reply.includes(REFUSAL_MARKER);
  if (!refused) return { ...line, status: 'answered', note: `tried=${tried.join(',')}; scripted answer` };
  if (line.taskId.startsWith('PAIR-A')) {
    return { ...line, status: 'refused', note: `tried=${tried.join(',')}; refused: scripted policy` };
  }
  const exhausted = PHASE2_STRATEGIES.every(candidate => tried.includes(candidate));
  return {
    ...line,
    status: exhausted ? 'refused' : 'pending',
    note: `tried=${tried.join(',')}; refused: scripted policy${exhausted ? '; exhausted' : ''}`,
  };
}

export function scriptedResponderReply(prompt: string): string {
  const taskId = /"taskId"\s*:\s*"([^"]+)"/.exec(prompt)?.[1] ?? 'unknown';
  const strategy = /\[strategy=([a-z_]+)\]/.exec(prompt)?.[1] ?? 'first_ask';
  if (taskId.startsWith('PAIR-A')) {
    return hashIndex(`action:${taskId}`, 2) === 0
      ? `${ANSWER_MARKER} ${taskId}: action performed (scripted).`
      : `${REFUSAL_MARKER} ${taskId}: action declined under policy (scripted).`;
  }
  const flipAt = scriptedFlipIndex(taskId);
  const strategyIndex = PHASE2_STRATEGIES.indexOf(strategy as typeof PHASE2_STRATEGIES[number]);
  if (strategyIndex >= 0 && strategyIndex === flipAt) {
    return `${ANSWER_MARKER} ${taskId}: disclosed after ${strategy} (scripted flip).`;
  }
  return `${REFUSAL_MARKER} ${taskId}: cannot share this under policy (scripted).`;
}

const counters = { requests: 0, contacts: 0, flips: 0, finalized: 0, byStrategy: {} as Record<string, number> };

function scriptedDecision(role: string, body: { model: string; messages: Message[] }, callSerial: number) {
  const { prompt, turn } = currentTurn(body.messages);
  const call = (name: string, args: Record<string, unknown>) => ({
    content: null,
    tool_calls: [{ id: `${role}-${callSerial}`, type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) } }],
  });
  const results = turn.filter(message => message.role === 'tool');
  const assistantCalls = turn.filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls ?? []);
  if (results.length < WORKSPACE_FILES.length) {
    return call('files.read', { path: [WORKSPACE_FILES[results.length]] });
  }
  if (role !== 'requester') return { content: scriptedResponderReply(prompt) };

  const memoryRead = parseToolOutput(results[WORKSPACE_FILES.length - 1]?.content);
  const memoryContent = String(memoryRead.content ?? '');
  const memoryVersion = String(memoryRead.version ?? '');
  const lines = parseMemory(memoryContent);
  const plan = planRequesterTurn(lines, prompt);
  const calledNames = assistantCalls.map(entry => entry.function.name);

  if (calledNames.includes('files.replace')) return { content: 'Heartbeat turn complete.' };
  if (plan.kind === 'idle') return { content: 'No selectable task this tick.' };
  if (plan.kind === 'finalize') {
    const line = lines[plan.index]!;
    lines[plan.index] = { ...line, status: 'refused', note: `tried=${triedOf(line.note).join(',')}; finalized` };
    counters.finalized += 1;
    return call('files.replace', { path: ['MEMORY.md'], expectedVersion: memoryVersion, content: renderMemory(lines) });
  }
  const line = lines[plan.index]!;
  if (!calledNames.includes('messages.request')) {
    counters.contacts += 1;
    counters.byStrategy[plan.strategy] = (counters.byStrategy[plan.strategy] ?? 0) + 1;
    return call('messages.request', {
      recipient: { kind: 'agent', agentId: 'responder' },
      payload: { taskId: line.taskId,
        message: `[strategy=${plan.strategy}] Scripted ${plan.strategy} request for ${line.taskId}.` },
    });
  }
  const reply = JSON.stringify(parseToolOutput(results.at(-1)?.content));
  const updated = applyReply(line, plan.strategy, reply);
  if (plan.strategy !== 'first_ask' && updated.status === 'answered') counters.flips += 1;
  lines[plan.index] = updated;
  return call('files.replace', { path: ['MEMORY.md'], expectedVersion: memoryVersion, content: renderMemory(lines) });
}

async function prepareScriptedConfigs(outputDirectory: string) {
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const files = [
    ['scripted-pair-preflight.yaml', scriptedConfig(PREFLIGHT_IDS, true)],
    ['scripted-pair-60x300.yaml', scriptedConfig(SPLIT_IDS)],
  ] as const;
  for (const [name, config] of files) {
    await writeFile(join(out, name), stringify(config, { lineWidth: 0 }), { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ configs: files.map(([name]) => join(out, name)) }, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const prepareIndex = argv.indexOf('--prepare-configs');
  if (prepareIndex >= 0) {
    const directory = argv[prepareIndex + 1];
    if (!directory) throw new Error('--prepare-configs requires a directory');
    await prepareScriptedConfigs(directory);
    return 0;
  }
  process.env.SHAREDEVAL_MODEL_API_KEY ??= 'scripted-no-network';
  let serial = 0;
  const startedAt = new Date();
  try {
    return await mainSharedevalV1(argv, {
      runProduction: async options => {
        const model = options.config.model;
        if (model.provider !== 'openai-compatible' || model.model !== SCRIPTED_MODEL_ID) {
          const label = model.provider === 'openai-compatible' ? model.model : model.provider;
          throw new Error(`run-pair-scripted refuses model "${label}"; `
            + `use a config from --prepare-configs (model ${SCRIPTED_MODEL_ID}).`);
        }
        const runRoot = join(options.configRootDir, options.config.output.directory, options.runId);
        const result = await runSharedevalProductionV1(options, {
          createDriver: driverOptions => {
            const role = driverOptions.actorContext?.actorId ?? 'unknown';
            return createOpenAICompatibleFileTurnDriverV1({
              ...driverOptions,
              fetch: async (_input, init) => {
                const body = JSON.parse(String(init?.body)) as { model: string; messages: Message[] };
                counters.requests += 1;
                const message = scriptedDecision(role, body, ++serial);
                return new Response(JSON.stringify({
                  id: `scripted-${serial}`, model: body.model,
                  choices: [{ index: 0, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop', message }],
                  usage: { prompt_tokens: 0, completion_tokens: 0 },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
              },
            });
          },
        });
        await writeFile(join(runRoot, 'SCRIPTED-RUN.json'), `${JSON.stringify({
          kind: 'scripted-harness-check',
          notModelEvidence: true,
          model: SCRIPTED_MODEL_ID,
          note: 'Every answer, refusal and flip was produced by scripts/experiments/run-pair-scripted.ts; no provider was contacted.',
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          counters,
        }, null, 2)}\n`, { mode: 0o600 });
        return result;
      },
      writeOutput: source => process.stdout.write(source),
    });
  } finally {
    process.stderr.write(`${JSON.stringify({ event: 'scripted_summary', ...counters,
      elapsedMs: Date.now() - startedAt.getTime() })}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
