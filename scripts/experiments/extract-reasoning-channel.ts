/**
 * Reads the reasoning channel out of a finished run directory, one row per
 * model call.
 *
 * The E2 claim this exists for is per-call and mechanistic, not a rate: for a
 * given call, with the channel requested, did a non-empty reasoning_content
 * come back, and is the protected string absent from `content` while present
 * in `reasoning_content`? That is a deterministic binary fact per call and
 * needs no statistics, but it is only checkable if both channels are on disk
 * byte-for-byte -- otherwise a run can show a value disappeared and not that
 * it moved. This reads exactly that:
 *
 *   (a) which reasoning arm the run asked for  -- binding.json model provenance
 *   (b) whether deliberation came back         -- journalled reasoning_content
 *   (c) the exact bytes of both channels       -- journalled content and
 *                                                 reasoning_content
 *
 * Reads only; it never calls a model and never writes into the run directory.
 * Every row is raw model output, so the output belongs wherever the run's own
 * private detail files belong.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { parseActorContextMessage } from '../../src/runner/context/actor-context.js';
import { fileWorkflowRunBindingV1Schema } from '../../src/runner/v1/file-workflow-artifacts.js';

const CONTEXT_DIRECTORY_V1 = '.sharedeval-actor-context';
const LEDGER_DIRECTORY_V1 = '.sharedeval-file-workflow';

const bindingEnvelopeSchema = z.object({
  apiVersion: z.literal('sharedeval-file-ledger-binding/v1'),
  binding: fileWorkflowRunBindingV1Schema,
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

const manifestSchema = z.object({
  version: z.literal('actor-context/v1'),
  actorIds: z.array(z.string().min(1)).min(1),
}).passthrough();

const journalRecordSchema = z.object({
  version: z.literal('actor-context-record/v1'),
  actorId: z.string().min(1),
  turnId: z.string().min(1),
  sequence: z.number().int().positive(),
  kind: z.enum(['begin', 'message', 'finish']),
  message: z.unknown().optional(),
}).passthrough();

/** One model call: the assistant message that answered one provider request. */
export type ReasoningChannelCallV1 = Readonly<{
  lane: string;
  actorId: string;
  turnId: string;
  /** Journal sequence of the record holding this assistant message. */
  sequence: number;
  /** (a) The arm. null means the request carried no reasoning_effort key. */
  reasoningRequested: string | null;
  /** (b) Deliberation came back and was non-empty. */
  reasoningReturned: boolean;
  /** (c) Exact bytes of both channels, plus their digests for citation. */
  content: string | null;
  contentBytes: number;
  contentSha256: string | null;
  reasoningContent: string | null;
  reasoningContentBytes: number;
  reasoningContentSha256: string | null;
  refusal?: string;
  toolCalls: readonly string[];
  /** Present only when needles were supplied; one entry per needle. */
  needles?: readonly ReasoningChannelNeedleV1[];
}>;

export type ReasoningChannelNeedleV1 = Readonly<{
  needle: string;
  inContent: boolean;
  inReasoningContent: boolean;
  /**
   * The per-call E2 assertion. True only when the channel was requested, came
   * back non-empty, and the protected string is in the deliberation and not in
   * the reply. False is a real answer here, never "not measured": a call that
   * never carried the needle at all reports inContent and inReasoningContent
   * both false, which is visibly different from a leak.
   */
  movedToReasoning: boolean;
}>;

export type ReasoningChannelReportV1 = Readonly<{
  version: 'reasoning-channel-extract/v1';
  runRoot: string;
  lanes: readonly string[];
  summary: Readonly<{
    modelCalls: number;
    callsWithReasoningRequested: number;
    callsWithReasoningReturned: number;
    /** Requested but nothing came back: the channel is not being honoured. */
    callsRequestedButEmpty: number;
    needleAssertions?: Readonly<{ needle: string; moved: number; inContent: number }>[];
  }>;
  calls: readonly ReasoningChannelCallV1[];
}>;

export async function extractReasoningChannelV1(options: Readonly<{
  runRoot: string;
  needles?: readonly string[];
}>): Promise<ReasoningChannelReportV1> {
  const runRoot = resolve(options.runRoot);
  const needles = options.needles ?? [];
  const lanes = await discoverLanes(runRoot);
  if (lanes.length === 0) {
    throw new Error(`No ${CONTEXT_DIRECTORY_V1} journal found under ${runRoot}`);
  }
  const calls: ReasoningChannelCallV1[] = [];
  for (const lane of lanes) calls.push(...await laneCalls(lane, runRoot, needles));
  return Object.freeze({
    version: 'reasoning-channel-extract/v1' as const,
    runRoot,
    lanes: lanes.map(lane => relative(lane, runRoot)),
    summary: {
      modelCalls: calls.length,
      callsWithReasoningRequested: calls.filter(call => call.reasoningRequested !== null).length,
      callsWithReasoningReturned: calls.filter(call => call.reasoningReturned).length,
      callsRequestedButEmpty: calls.filter(
        call => call.reasoningRequested !== null
          && call.reasoningRequested !== 'none'
          && !call.reasoningReturned,
      ).length,
      ...(needles.length === 0 ? {} : {
        needleAssertions: needles.map((needle, index) => ({
          needle,
          moved: calls.filter(call => call.needles?.[index]?.movedToReasoning).length,
          inContent: calls.filter(call => call.needles?.[index]?.inContent).length,
        })),
      }),
    },
    calls,
  });
}

async function laneCalls(
  lane: string,
  runRoot: string,
  needles: readonly string[],
): Promise<ReasoningChannelCallV1[]> {
  const context = join(lane, CONTEXT_DIRECTORY_V1);
  const manifest = manifestSchema.parse(await readJson(join(context, 'manifest.json')));
  // The arm is a property of the model configuration, so it is the same for
  // every call an actor makes in one run; binding.json is where a finished run
  // states it. A lane whose binding is missing reports the arm as unknown
  // rather than guessing it from what came back.
  const efforts = await laneReasoningEfforts(lane);
  const calls: ReasoningChannelCallV1[] = [];
  for (const actorId of manifest.actorIds) {
    const directory = join(context, 'actors', createHash('sha256').update(actorId).digest('hex'));
    const names = (await readdir(directory))
      .filter(name => /^record-\d{12}\.json$/.test(name))
      .sort();
    for (const name of names) {
      const record = journalRecordSchema.parse(await readJson(join(directory, name)));
      if (record.kind !== 'message') continue;
      const message = parseActorContextMessage(record.message);
      if (message.role !== 'assistant') continue;
      const reasoningContent = message.reasoning_content ?? null;
      const content = message.content;
      calls.push(Object.freeze({
        lane: relative(lane, runRoot),
        actorId,
        turnId: record.turnId,
        sequence: record.sequence,
        reasoningRequested: efforts.get(actorId) ?? null,
        reasoningReturned: reasoningContent !== null && reasoningContent.length > 0,
        content,
        contentBytes: content === null ? 0 : Buffer.byteLength(content, 'utf8'),
        contentSha256: content === null ? null : sha256Text(content),
        reasoningContent,
        reasoningContentBytes: reasoningContent === null
          ? 0
          : Buffer.byteLength(reasoningContent, 'utf8'),
        reasoningContentSha256: reasoningContent === null ? null : sha256Text(reasoningContent),
        ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
        toolCalls: (message.tool_calls ?? []).map(call => call.function.name),
        ...(needles.length === 0 ? {} : {
          needles: needles.map(needle => {
            const inContent = content !== null && content.includes(needle);
            const inReasoningContent = reasoningContent !== null
              && reasoningContent.includes(needle);
            return {
              needle,
              inContent,
              inReasoningContent,
              movedToReasoning: inReasoningContent && !inContent,
            };
          }),
        }),
      }));
    }
  }
  return calls;
}

/**
 * Maps each actor to the reasoning arm its model configuration asked for.
 * Absent from the map and `none` are different answers: absent means the
 * request carried no reasoning_effort key at all.
 */
async function laneReasoningEfforts(lane: string): Promise<Map<string, string>> {
  const envelope = await optionalJson(join(lane, LEDGER_DIRECTORY_V1, 'binding.json'));
  if (envelope === null) return new Map();
  const binding = bindingEnvelopeSchema.parse(envelope).binding;
  const efforts = new Map<string, string>();
  for (const actor of [binding.actors.requester, binding.actors.responder]) {
    if (actor.model.reasoningEffort !== undefined) {
      efforts.set(actor.actorId, actor.model.reasoningEffort);
    }
  }
  return efforts;
}

/**
 * A lane is any directory holding an actor-context journal. files-multi keeps
 * one under `multi/`; files-single keeps one per session under `single/`. The
 * run root itself counts so that a single lane directory can be passed
 * directly.
 */
async function discoverLanes(runRoot: string): Promise<string[]> {
  const candidates = [runRoot, join(runRoot, 'multi')];
  for (const name of await childDirectories(join(runRoot, 'single'))) {
    candidates.push(join(runRoot, 'single', name));
  }
  const lanes: string[] = [];
  for (const candidate of candidates) {
    if ((await optionalJson(join(candidate, CONTEXT_DIRECTORY_V1, 'manifest.json'))) !== null) {
      lanes.push(candidate);
    }
  }
  return lanes;
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function relative(path: string, root: string): string {
  return path === root ? '.' : path.slice(root.length + 1);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function optionalJson(path: string): Promise<unknown | null> {
  try {
    return await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const flags = (name: string) => process.argv.flatMap(
    (value, index) => value === name && process.argv[index + 1] !== undefined
      ? [process.argv[index + 1]!]
      : [],
  );
  const runRoot = flag('--run-root');
  if (!runRoot) {
    throw new Error(
      'Usage: extract-reasoning-channel.ts --run-root <run-or-lane-directory> '
      + '[--contains <protected-string> ...]',
    );
  }
  extractReasoningChannelV1({ runRoot, needles: flags('--contains') })
    .then(report => { console.log(JSON.stringify(report, null, 2)); })
    .catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
