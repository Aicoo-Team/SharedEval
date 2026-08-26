import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type AgentWorkspaceTemplateLoader = (options: {
  rootDir: string;
}) => Promise<unknown>;

type LoadedAgentWorkspaceTemplate = {
  files: {
    agent: { content: string };
    heartbeat: { content: string };
    policy: { content: string };
    memory: { content: string };
  };
};

test('loads only the four explicit agent workspace files with fixed access modes', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  try {
    await Promise.all([
      writeFile(join(rootDir, 'AGENT.md'), 'agent\n'),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
      writeFile(join(rootDir, 'gold_answers.json'), '{"secret":true}\n'),
    ]);

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');

    const template = await (loader as AgentWorkspaceTemplateLoader)({ rootDir });
    assert.deepEqual(template, {
      apiVersion: 'sharedeval/agent-workspace/v1',
      kind: 'AgentWorkspaceTemplate',
      files: {
        agent: {
          path: 'AGENT.md',
          access: 'read_only',
          content: 'agent\n',
          sha256: 'd20bc21bb3c7736d8d03ade3ddb4c68b665cdfbca6f6df0f7fdd192f37f59060',
        },
        heartbeat: {
          path: 'HEARTBEAT.md',
          access: 'read_only',
          content: 'heartbeat\n',
          sha256: '8c109433beff6838f213a46de7f5e3ef57bded41047ea437cdd57e09f835a867',
        },
        policy: {
          path: 'POLICY.md',
          access: 'read_only',
          content: 'policy\n',
          sha256: 'c82fc52c78bf8154d4dd7d8766c422ab151052d72098d72ded237aafcd78e4e0',
        },
        memory: {
          path: 'MEMORY.md',
          access: 'read_write',
          content: '# Progress\n',
          sha256: '278a8236256ab76c294d9aca48ee72a2419bf33596ab7138181079be948a70aa',
        },
      },
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a symbolic link instead of reading outside the explicit file boundary', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  try {
    await Promise.all([
      writeFile(join(rootDir, 'outside.md'), 'host-only secret\n'),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);
    await symlink('outside.md', join(rootDir, 'AGENT.md'));

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');
    await assert.rejects(
      () => (loader as AgentWorkspaceTemplateLoader)({ rootDir }),
      /symbolic link|regular file/i,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a symbolic-link workspace root', async () => {
  const containerDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  const rootDir = join(containerDir, 'real');
  const linkedRootDir = join(containerDir, 'linked');
  try {
    await mkdir(rootDir);
    await Promise.all([
      writeFile(join(rootDir, 'AGENT.md'), 'agent\n'),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);
    await symlink(rootDir, linkedRootDir, 'dir');

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');
    await assert.rejects(
      () => (loader as AgentWorkspaceTemplateLoader)({ rootDir: linkedRootDir }),
      /workspace root must be a real directory/,
    );
  } finally {
    await rm(containerDir, { recursive: true, force: true });
  }
});

test('rejects an agent workspace file larger than the one-megabyte contract', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  try {
    await Promise.all([
      writeFile(join(rootDir, 'AGENT.md'), 'a'.repeat(1_048_577)),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');
    await assert.rejects(
      () => (loader as AgentWorkspaceTemplateLoader)({ rootDir }),
      /AGENT\.md exceeds 1048576 bytes/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('accepts an agent workspace file exactly at the one-megabyte contract', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  try {
    await Promise.all([
      writeFile(join(rootDir, 'AGENT.md'), 'a'.repeat(1_048_576)),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');
    const template = await (
      loader as AgentWorkspaceTemplateLoader
    )({ rootDir }) as LoadedAgentWorkspaceTemplate;

    assert.equal(template.files.agent.content.length, 1_048_576);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects invalid UTF-8 instead of hashing replacement text', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  try {
    await Promise.all([
      writeFile(join(rootDir, 'AGENT.md'), Buffer.from([0xff, 0xfe])),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');
    await assert.rejects(
      () => (loader as AgentWorkspaceTemplateLoader)({ rootDir }),
      /AGENT\.md must be valid UTF-8/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rejects a FIFO without waiting for a writer', {
  skip: process.platform === 'win32',
}, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  const agentPath = join(rootDir, 'AGENT.md');
  try {
    execFileSync('mkfifo', [agentPath]);
    await Promise.all([
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');

    const delayedWriter = (async () => {
      await delay(300);
      try {
        const handle = await open(
          agentPath,
          constants.O_WRONLY | constants.O_NONBLOCK,
        );
        await handle.close();
      } catch {
        // A prompt rejection leaves no reader for the cleanup writer.
      }
    })();
    const startedAt = performance.now();
    const outcome = await (loader as AgentWorkspaceTemplateLoader)({ rootDir })
      .then(() => 'resolved', () => 'rejected');
    const elapsedMs = performance.now() - startedAt;
    await delayedWriter;

    assert.equal(outcome, 'rejected');
    assert.ok(
      elapsedMs < 200,
      `FIFO rejection waited ${Math.round(elapsedMs)}ms for a writer`,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('loads every canonical agent from AGENT.md', async () => {
  const runner = await import('../../src/runner/v1/index.js');
  const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
  assert.equal(typeof loader, 'function');

  for (const agent of ['alex', 'dana', 'jordan', 'marcus', 'tina']) {
    const rootDir = join(
      repoRoot,
      'dataset',
      'pact-pair',
      'agent_configs',
      agent,
    );
    await assert.doesNotReject(
      () => (loader as AgentWorkspaceTemplateLoader)({ rootDir }),
      `${agent} must provide the canonical four-file workspace`,
    );
  }
});

test('does not substitute legacy COO.md when AGENT.md is missing', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'sharedeval-agent-workspace-'));
  try {
    await Promise.all([
      writeFile(join(rootDir, 'COO.md'), 'legacy identity\n'),
      writeFile(join(rootDir, 'HEARTBEAT.md'), 'heartbeat\n'),
      writeFile(join(rootDir, 'POLICY.md'), 'policy\n'),
      writeFile(join(rootDir, 'MEMORY.md'), '# Progress\n'),
    ]);

    const runner = await import('../../src/runner/v1/index.js');
    const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
    assert.equal(typeof loader, 'function');
    await assert.rejects(
      () => (loader as AgentWorkspaceTemplateLoader)({ rootDir }),
      /AGENT\.md/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('drives Tina from selected tasks while keeping policy and memory aligned', async () => {
  const runner = await import('../../src/runner/v1/index.js');
  const loader = Reflect.get(runner, 'loadAgentWorkspaceTemplateV1');
  assert.equal(typeof loader, 'function');
  const rootDir = join(
    repoRoot,
    'dataset',
    'pact-pair',
    'agent_configs',
    'tina',
  );
  const template = await (
    loader as AgentWorkspaceTemplateLoader
  )({ rootDir }) as LoadedAgentWorkspaceTemplate;

  assert.match(template.files.heartbeat.content, /all selected tasks/i);
  assert.doesNotMatch(template.files.heartbeat.content, /ALL \d+ questions/);

  const expectedNumbers = Array.from({ length: 200 }, (_, index) => index + 1);
  const policyNumbers = Array.from(
    template.files.policy.content.matchAll(/^(\d+)\.\s/gm),
    match => Number(match[1]),
  );
  const memoryNumbers = Array.from(
    template.files.memory.content.matchAll(/^(\d+)\.\s/gm),
    match => Number(match[1]),
  );
  assert.equal(policyNumbers.length, 200);
  assert.deepEqual(policyNumbers, expectedNumbers);
  assert.deepEqual(memoryNumbers, policyNumbers);
});
