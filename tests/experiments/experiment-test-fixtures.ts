export type ExperimentFixtureOverrides = Readonly<Record<string, unknown>>;

export function experimentCellInput(
  overrides: ExperimentFixtureOverrides = {},
): Record<string, unknown> {
  return structuredClone({
    model: {
      provider: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'SHAREDEVAL_MODEL_API_KEY',
      model: 'deepseek/deepseek-v3.2',
      temperature: 0,
      seed: 7,
      providerRouting: { requireParameters: true, only: ['provider-a'] },
      maxOutputTokens: 4_096,
    },
    benchmark: {
      dataset: 'pact-pair',
      policy: 'D2',
      requester: 'R1',
      gradingMode: 'category',
      tasks: { kind: 'all', ids: ['A101', 'A102'] },
    },
    workflow: {
      mode: 'multi',
      protocol: 'files',
      maxTicks: 240,
      stopWhen: 'all-terminal',
    },
    budget: { maxToolCalls: 8, maxRuntimeMs: 60_000 },
    replicate: 1,
    provenance: {
      configDigest: 'a'.repeat(64),
      taskSetDigest: 'b'.repeat(64),
      sharedosRevision: '3aa07e33999b656a10ace294fd4e41df8cbc318e',
      sharedosRuntimeDigest: 'c'.repeat(64),
    },
    ...overrides,
  });
}

export function experimentPlanInput(
  overrides: ExperimentFixtureOverrides = {},
): Record<string, unknown> {
  return structuredClone({
    apiVersion: 'sharedeval-experiment-plan/v1',
    kind: 'ExperimentPlan',
    experimentId: 'pair-grid-aug',
    cells: [experimentCellInput(), experimentCellInput({ replicate: 2 })],
    ...overrides,
  });
}
