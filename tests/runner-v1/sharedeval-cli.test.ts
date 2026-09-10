import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mainSharedevalV1,
  parseSharedevalCliArgumentsV1,
} from '../../src/runner/v1/sharedeval-cli.js';

test('parses default multi and explicit multi and single commands', () => {
  assert.equal(
    parseSharedevalCliArgumentsV1(['--config', 'run.yaml', '--check']).workflow.id,
    'files-multi',
  );
  assert.deepEqual(
    parseSharedevalCliArgumentsV1(['multi', '--config', 'run.yaml', '--check']),
    {
      configPath: 'run.yaml',
      check: true,
      worldHash: false,
      workflow: {
        id: 'files-multi',
        mode: 'multi',
        protocol: 'files',
        maxTicks: 240,
        stopWhen: 'all-terminal',
      },
    },
  );
  assert.deepEqual(
    parseSharedevalCliArgumentsV1([
      'single', '--config=run.yaml', '--run-id', 'single-run-7',
      '--task', 'PAIR-Q-0101', '--max-ticks=7',
    ]),
    {
      configPath: 'run.yaml',
      check: false,
      worldHash: false,
      runId: 'single-run-7',
      taskIds: ['PAIR-Q-0101'],
      maxTicks: 7,
      workflow: {
        id: 'files-single',
        mode: 'single',
        protocol: 'files',
        maxTicks: 240,
        stopWhen: 'all-terminal',
      },
    },
  );
});

test('accepts one safe run id and rejects duplicate or unsafe identities', () => {
  assert.equal(
    parseSharedevalCliArgumentsV1([
      'multi', '--config', 'run.yaml', '--run-id=run:2026-08-26.1', '--check',
    ]).runId,
    'run:2026-08-26.1',
  );
  for (const argv of [
    ['multi', '--config', 'run.yaml', '--run-id', '../escape'],
    ['multi', '--config', 'run.yaml', '--run-id', 'one', '--run-id', 'two'],
  ]) {
    assert.throws(() => parseSharedevalCliArgumentsV1(argv), /run id|--run-id/i);
  }
});

test('rejects legacy flags before reading configuration', () => {
  assert.throws(
    () => parseSharedevalCliArgumentsV1(['multi', '--legacy', '--config', 'missing.yaml']),
    /legacy workflows are not supported/i,
  );
});

test('dispatches omitted mode to the canonical multi production workflow', async () => {
  await withConfig(configYaml(), async configPath => {
    let dispatchedMode: string | undefined;
    assert.equal(await mainSharedevalV1([
      '--config', configPath,
      '--run-id', 'default-production-1',
    ], {
      writeOutput: () => {},
      runProduction: async input => {
        dispatchedMode = input.config.workflow.mode;
        return {
          runId: input.runId,
          workflowId: input.config.workflow.id,
          runRoot: `/runs/${input.runId}`,
          sourceRevision: 'a'.repeat(40),
          run: { workflowId: input.config.workflow.id } as never,
        };
      },
    }), 0);
    assert.equal(dispatchedMode, 'multi');
  });
});

test('rejects unknown flags without reflecting untrusted argument text', () => {
  const untrusted = '--token=do-not-reflect';
  assert.throws(
    () => parseSharedevalCliArgumentsV1(['multi', '--config', 'run.yaml', untrusted]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown Sharedeval argument/i);
      assert.equal(error.message.includes(untrusted), false);
      return true;
    },
  );
});

test('rejects invalid max tick counts before execution', () => {
  for (const value of ['0', '1.5', '10001']) {
    assert.throws(
      () => parseSharedevalCliArgumentsV1([
        'multi', '--config', 'run.yaml', '--max-ticks', value,
      ]),
      /--max-ticks must be a positive safe integer up to 10000/,
    );
  }
});

test('rejects old configs, pact-net, backend selection, and overlong runtime before execution', async () => {
  const fixtures = [
    'apiVersion: pact-run/v1\nkind: RunConfig\n',
    configYaml('  dataset: pact-net\n'),
    configYaml('', 'backend:\n  kind: local\n'),
    configYaml('', '', 'budget:\n  maxToolCalls: 8\n  maxRuntimeMs: 600001\n'),
  ];

  for (const source of fixtures) {
    await withConfig(source, async configPath => {
      await assert.rejects(
        () => mainSharedevalV1(['multi', '--config', configPath]),
        /Sharedeval run configuration is invalid/,
      );
    });
  }
});

test('--check validates without creating output or entering production composition', async () => {
  await withConfig(configYaml(), async configPath => {
    const writes: string[] = [];
    let productionCalls = 0;
    assert.equal(await mainSharedevalV1(
      ['multi', '--config', configPath, '--check'],
      {
        writeOutput: source => writes.push(source),
        runProduction: async () => {
          productionCalls += 1;
          throw new Error('production must not run during --check');
        },
      },
    ), 0);
    assert.match(writes.join(''), /"valid": true/);
    assert.equal(productionCalls, 0);
    await assert.rejects(() => access(path.join(path.dirname(configPath), 'runs')));
  });
});

test('dispatches explicit multi and single commands to production with exact run identity', async () => {
  const dispatched: Array<{ runId: string; mode: string; rootDir: string }> = [];
  for (const mode of ['multi', 'single'] as const) {
    await withConfig(configYaml('', '', '', mode), async configPath => {
      const exitCode = await mainSharedevalV1([
        mode,
        '--config', configPath,
        '--run-id', `${mode}-production-1`,
      ], {
        writeOutput: () => {},
        runProduction: async input => {
          dispatched.push({
            runId: input.runId,
            mode: input.config.workflow.mode,
            rootDir: input.configRootDir,
          });
          return {
            runId: input.runId,
            workflowId: input.config.workflow.id,
            runRoot: `/runs/${input.runId}`,
            sourceRevision: 'a'.repeat(40),
            run: { workflowId: input.config.workflow.id } as never,
          };
        },
      });
      assert.equal(exitCode, 0);
    });
  }
  assert.deepEqual(dispatched.map(({ runId, mode }) => ({ runId, mode })), [
    { runId: 'multi-production-1', mode: 'multi' },
    { runId: 'single-production-1', mode: 'single' },
  ]);
  assert.ok(dispatched.every(entry => path.isAbsolute(entry.rootDir)));
});

test('requires --run-id only when execution is requested', async () => {
  await withConfig(configYaml(), async configPath => {
    assert.equal(await mainSharedevalV1(
      ['multi', '--config', configPath, '--check'],
      { writeOutput: () => {} },
    ), 0);
    await assert.rejects(
      () => mainSharedevalV1(['multi', '--config', configPath], { writeOutput: () => {} }),
      /--run-id.*required/i,
    );
  });
});

async function withConfig(
  source: string,
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharedeval-cli-'));
  const configPath = path.join(directory, 'run.yaml');
  await writeFile(configPath, source, 'utf8');
  try {
    await run(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function configYaml(
  benchmarkExtra = '',
  rootExtra = '',
  budget = '',
  mode: 'multi' | 'single' = 'multi',
): string {
  return `
apiVersion: sharedeval-run/v1
kind: RunConfig
${rootExtra}model:
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: example-model
workflow:
  mode: ${mode}
  protocol: files
  maxTicks: 2
  stopWhen: all-terminal
benchmark:
${benchmarkExtra}  tasks:
    kind: all
${budget}output:
  directory: runs
  saveTraces: false
`;
}
