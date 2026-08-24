import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  pactRunConfigV1Schema,
  type PactRunConfigV1,
} from '../../../src/runner/v1/config.js';
import {
  createPactNetModelHarnessV1,
  loadPactNetTasksV1,
  type LoadedPactNetQaTaskV1,
  type PactNetObservationV1,
} from '../../../src/suites/pact-net/index.js';

const TEST_KEY = 'net-unit-test-key';

const qaTask = requireQaTask('NET-Q-0010');
const answerTask = requireQaTask('NET-Q-0001');

function requireQaTask(id: string): LoadedPactNetQaTaskV1 {
  const [task] = loadPactNetTasksV1({ policy: 'D2', kind: 'qa', ids: [id] });
  assert.ok(task && task.kind === 'qa');
  return task;
}

function netConfig(policy: 'D0' | 'D2' = 'D2'): PactRunConfigV1 {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
      model: 'example-model',
      temperature: 0.2,
    },
    benchmark: {
      dataset: 'pact-net',
      policy,
      tasks: { kind: 'all' },
    },
    budget: { maxTurns: 8, maxToolCalls: 4, maxRuntimeMs: 60_000 },
    output: { directory: 'runs', saveTraces: false },
  });
}

function azureNetConfig(): PactRunConfigV1 {
  return pactRunConfigV1Schema.parse({
    apiVersion: 'pact-run/v1',
    kind: 'RunConfig',
    model: {
      provider: 'azure-openai',
      endpoint: 'https://contoso.openai.azure.com/openai/v1',
      deployment: 'kimi-k2-eval',
      apiKeyEnv: 'PACT_MODEL_API_KEY',
    },
    benchmark: { dataset: 'pact-net', policy: 'D2', tasks: { kind: 'all' } },
    budget: { maxTurns: 8, maxToolCalls: 4, maxRuntimeMs: 60_000 },
    output: { directory: 'runs', saveTraces: false },
  });
}

function taskObservation(task: LoadedPactNetQaTaskV1): PactNetObservationV1 {
  return {
    type: 'task',
    turn: 0,
    task: task.publicTask,
    budgetRemaining: { turns: 8, toolCalls: 4, runtimeMs: 60_000 },
  };
}

function completionWithTool(id: string, name: string, args: string | object) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: {
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          },
        }],
      },
    }],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse(responses.shift());
  }) as typeof fetch;
  return { calls, fetchMock };
}

function createHarness(
  fetchMock: typeof fetch,
  config: PactRunConfigV1 = netConfig(),
  task: LoadedPactNetQaTaskV1 = qaTask,
) {
  return createPactNetModelHarnessV1(config, task.publicTask, {
    fetch: fetchMock,
    environment: { PACT_MODEL_API_KEY: TEST_KEY },
  });
}

test('maps runner and terminal tool calls into PACT-Net decisions', async () => {
  const { calls, fetchMock } = recordingFetch([
    completionWithTool('call-1', 'search_notes', { query: 'presentation' }),
    completionWithTool('call-2', 'pact_answer', { content: 'Here is the summary.' }),
  ]);
  const harness = createHarness(fetchMock);

  const first = await harness.step(taskObservation(qaTask));
  assert.deepEqual(first, {
    type: 'tool_call',
    toolName: 'search_notes',
    input: { query: 'presentation' },
  });

  const second = await harness.step({
    type: 'tool_result',
    turn: 1,
    toolCallId: 'net-tool-1',
    toolName: 'search_notes',
    output: [],
    isError: false,
    budgetRemaining: { turns: 7, toolCalls: 3, runtimeMs: 50_000 },
  });
  assert.deepEqual(second, { type: 'answer', content: 'Here is the summary.' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, 'https://api.example.com/v1/chat/completions');
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${TEST_KEY}`);
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string;
    max_tokens: number;
    tool_choice: string;
    tools: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, 'example-model');
  assert.equal(body.max_tokens, 4_096);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(
    body.tools.map(tool => tool.function.name),
    [
      'search_notes',
      'get_note',
      'create_note',
      'edit_note',
      'search_todos',
      'get_todo',
      'create_todo',
      'complete_todo',
      'pact_answer',
      'pact_refuse',
      'pact_escalate',
    ],
  );
  assert.equal(body.messages[0]?.role, 'system');
  assert.match(String(body.messages[0]?.content), /PACT-Net benchmark/);
  assert.match(String(body.messages[1]?.content), new RegExp(qaTask.taskId));
});

test('D2 includes the target agent POLICY.md and D0 omits it', async () => {
  const policyText = readFileSync(
    fileURLToPath(new URL(
      `../../../dataset/pact-net/agent_configs/${qaTask.targetAgent}/POLICY.md`,
      import.meta.url,
    )),
    'utf8',
  ).trim();
  assert.ok(policyText.length > 0);
  const policyMarker = policyText.split('\n').find(line =>
    line.trim().length > 40);
  assert.ok(policyMarker);

  for (const [policy, expectPolicy] of [['D2', true], ['D0', false]] as const) {
    const { calls, fetchMock } = recordingFetch([
      completionWithTool('call-1', 'pact_refuse', { reason: 'No.' }),
    ]);
    const harness = createHarness(fetchMock, netConfig(policy));
    await harness.step(taskObservation(qaTask));
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = String(body.messages[0]?.content);
    assert.equal(system.includes(policyMarker.trim()), expectPolicy);
    assert.equal(system.includes('Privacy policy (POLICY.md)'), expectPolicy);
    // COO/USER always present under both conditions.
    assert.match(system, /Operating instructions \(COO\.md\)/);
    assert.match(system, /Owner identity \(USER\.md\)/);
  }
});

test('never places gold or the credential in the model-visible payload', async () => {
  const { calls, fetchMock } = recordingFetch([
    completionWithTool('call-1', 'get_note', { title: 'anything' }),
    completionWithTool('call-2', 'pact_refuse', { reason: 'Private.' }),
  ]);
  const harness = createHarness(fetchMock);
  await harness.step(taskObservation(qaTask));
  await harness.step({
    type: 'tool_result',
    turn: 1,
    toolCallId: 'net-tool-1',
    toolName: 'get_note',
    output: { error: 'Note "anything" was not found' },
    isError: true,
    budgetRemaining: { turns: 7, toolCalls: 3, runtimeMs: 50_000 },
  });

  const serializedRequests = calls
    .map(call => String(call.init?.body))
    .join('\n');
  // Gold structure names must never reach the provider.
  for (const marker of [
    'gold_key_facts',
    'minimum_correct',
    'relational_labels',
    'sensitive_facts_in_scope',
    'expectedBehavior',
    'gold_check',
    'delegation_chain',
    'planted_sensitive_facts',
    'transitive_leak_rule',
  ]) {
    assert.doesNotMatch(serializedRequests, new RegExp(marker), marker);
  }
  // Gold values (fact texts, the grading rubric) must not either — except
  // strings the public question already quotes (e.g. a note title named in
  // the prompt), which are public by construction.
  const publicText = JSON.stringify(qaTask.publicTask);
  const goldValues = [
    ...qaTask.question.gold_key_facts,
    qaTask.question.minimum_correct,
    ...qaTask.sensitiveFactsInScope.map(fact => fact.fact),
  ].filter(value => !publicText.includes(JSON.stringify(value).slice(1, -1)));
  assert.ok(goldValues.length > 0, 'expected private gold values to check');
  for (const value of goldValues) {
    assert.equal(
      serializedRequests.includes(JSON.stringify(value).slice(1, -1)),
      false,
      `gold value leaked into the model payload: ${value}`,
    );
  }
  assert.doesNotMatch(serializedRequests, /"relationalLabel"/);
  // The provider credential lives in the auth header only.
  assert.equal(serializedRequests.includes(TEST_KEY), false);
});

test('keeps the Pair error vocabulary byte-identical for watch_runs', async () => {
  {
    const { fetchMock } = recordingFetch([{ choices: [{ message: { content: '' } }] }]);
    const harness = createHarness(fetchMock, netConfig(), answerTask);
    await assert.rejects(
      Promise.resolve(harness.step(taskObservation(answerTask))),
      (error: Error) => {
        assert.equal(error.message, 'OpenAI-compatible provider returned no decision');
        return true;
      },
    );
  }
  {
    const { fetchMock } = recordingFetch([
      completionWithTool('call-1', 'search_notes', 'not valid json'),
    ]);
    const harness = createHarness(fetchMock, netConfig(), answerTask);
    await assert.rejects(
      Promise.resolve(harness.step(taskObservation(answerTask))),
      (error: Error) => {
        assert.equal(
          error.message,
          'OpenAI-compatible provider returned invalid tool arguments',
        );
        return true;
      },
    );
  }
  {
    // edit_todo exists in PACT-Pair but not in the PACT-Net surface.
    const { fetchMock } = recordingFetch([
      completionWithTool('call-1', 'edit_todo', { title: 'x', content: 'y' }),
    ]);
    const harness = createHarness(fetchMock, netConfig(), answerTask);
    await assert.rejects(
      Promise.resolve(harness.step(taskObservation(answerTask))),
      (error: Error) => {
        assert.equal(
          error.message,
          'OpenAI-compatible provider selected an unavailable tool',
        );
        return true;
      },
    );
  }
});

test('supports the azure-openai provider with api-key auth and deployment model', async () => {
  const { calls, fetchMock } = recordingFetch([
    completionWithTool('call-1', 'pact_answer', { content: 'Done.' }),
  ]);
  const harness = createHarness(fetchMock, azureNetConfig(), answerTask);
  const decision = await harness.step(taskObservation(answerTask));
  assert.deepEqual(decision, { type: 'answer', content: 'Done.' });

  assert.equal(
    calls[0]?.url,
    'https://contoso.openai.azure.com/openai/v1/chat/completions',
  );
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('api-key'), TEST_KEY);
  assert.equal(headers.get('authorization'), null);
  const body = JSON.parse(String(calls[0]?.init?.body)) as { model: string };
  assert.equal(body.model, 'kimi-k2-eval');
});

test('exposes provider telemetry for run artifacts', async () => {
  const { fetchMock } = recordingFetch([
    {
      id: 'resp-1',
      model: 'example-model-served',
      usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
      ...completionWithTool('call-1', 'pact_answer', { content: 'Done.' }),
    },
  ]);
  const harness = createHarness(fetchMock, netConfig(), answerTask);
  await harness.step(taskObservation(answerTask));
  const telemetry = (harness as unknown as {
    getProviderTelemetryV1(): { totals: Record<string, number>; requests: unknown[] };
  }).getProviderTelemetryV1();
  assert.equal(telemetry.requests.length, 1);
  assert.equal(telemetry.totals['requests'], 1);
  assert.equal(telemetry.totals['promptTokens'], 120);
  assert.equal(telemetry.totals['totalTokens'], 128);
});
