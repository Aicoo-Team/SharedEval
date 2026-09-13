import { pathToFileURL } from 'node:url';
import { createCodexAppServerTransport, CODEX_TRANSPORT_BASE_URL } from './codex-app-server-transport.js';

/** One native tool response and one continuation, never benchmark data or a host file operation. */
export async function runCodexTransportCanary(options: { model: string; evidenceDirectory: string }) {
  const transport = createCodexAppServerTransport({ ...options, actorId: 'canary', maxNativeToolCalls: 1,
    effort: 'medium', timeoutMs: 180_000 });
  const messages: unknown[] = [{ role: 'user', content: [
    'This is a bounded transport canary. Call the provided dummy.ping tool exactly once with ping equal to ok.',
    'Then answer only OK. Do not use any other tools. No real file operations are part of this canary.',
  ].join(' ') }];
  const body = () => JSON.stringify({ model: options.model, messages, max_tokens: 128,
    tools: [{ type: 'function', function: { name: 'dummy.ping',
      description: 'A transport-only echo. This tool does not read files, execute commands, or contact external services.',
      parameters: { type: 'object', additionalProperties: false, properties: { ping: { type: 'string', const: 'ok' } }, required: ['ping'] },
    } }] });
  const request = () => transport.fetch(`${CODEX_TRANSPORT_BASE_URL}/chat/completions`, { method: 'POST', body: body() });
  try {
    const preflight = await transport.preflight();
    console.log(JSON.stringify({ stage: 'preflight', cliVersion: preflight.cliVersion, model: options.model, effort: preflight.effort }));
    const first = await (await request()).json() as { choices: [{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }] };
    const calls = first.choices[0].message.tool_calls;
    if (calls?.length !== 1 || calls[0]!.function.name !== 'dummy.ping'
      || calls[0]!.function.arguments !== '{"ping":"ok"}') throw new Error('native_canary_unexpected_decision');
    messages.push(first.choices[0].message, { role: 'tool', tool_call_id: calls[0]!.id,
      content: JSON.stringify({ status: 'succeeded', output: { pong: 'ok' } }) });
    const second = await (await request()).json() as { choices: [{ message: { content?: string; tool_calls?: unknown[] } }] };
    if (second.choices[0].message.tool_calls?.length || second.choices[0].message.content?.trim() !== 'OK') throw new Error('native_canary_missing_completion');
    const result = { stage: 'completed', model: options.model, nativeToolCalls: 1,
      nativeModelContinuations: 1, unexpectedNativeItems: false, evidence: transport.evidence() };
    console.log(JSON.stringify(result));
    return result;
  } finally { await transport.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [model, evidenceDirectory] = process.argv.slice(2);
  if (!model || !evidenceDirectory) throw new Error('Usage: codex-app-server-transport-canary.ts MODEL EVIDENCE_DIRECTORY');
  await runCodexTransportCanary({ model, evidenceDirectory });
}
