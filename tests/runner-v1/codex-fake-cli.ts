/**
 * A stand-in for `codex exec` used by the bridge tests. It honours the parts
 * of the real CLI contract the driver depends on:
 *   - argv: `exec --json --skip-git-repo-check --sandbox read-only -C <cwd>
 *     -o <last-message-file> [extra...] -` with the prompt on stdin;
 *   - CODEX_HOME/config.toml names the MCP server command, args and env;
 *   - it spawns that MCP server over stdio and drives it with real MCP
 *     JSON-RPC (initialize, initialized, tools/list, tools/call);
 *   - it writes the final message to the `-o` file and emits JSONL events.
 *
 * `--fake-mode <mode>` (passed through harness.extraArgs) selects a scenario.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

type Mode = 'ok' | 'parallel' | 'fail' | 'hang' | 'silent';

const argv = process.argv.slice(2);
const mode = (argv[argv.indexOf('--fake-mode') + 1] ?? 'ok') as Mode;
const outputPath = argv[argv.indexOf('-o') + 1]!;
const prompt = readFileSync(0, 'utf8');
const configPath = join(process.env['CODEX_HOME']!, 'config.toml');
const config = readFileSync(configPath, 'utf8');
const apiKey = process.env['SHAREDEVAL_MODEL_API_KEY'] ?? '';

if (argv[0] !== 'exec' || !argv.includes('--json') || argv.at(-1) !== '-') {
  process.stderr.write('fake codex: unexpected argv\n');
  process.exit(64);
}
if (apiKey && config.includes(apiKey)) {
  process.stderr.write('fake codex: credential leaked into config.toml\n');
  process.exit(65);
}
if (!/wire_api = "chat"/.test(config) || !/env_key = "SHAREDEVAL_MODEL_API_KEY"/.test(config)) {
  process.stderr.write('fake codex: provider block is incomplete\n');
  process.exit(66);
}

if (mode === 'fail') {
  process.stderr.write(`fake codex failed while holding ${apiKey}\n`);
  process.exit(2);
}
if (mode === 'silent') {
  process.exit(0);
}
if (mode === 'hang') {
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => undefined, 1_000);
} else {
  void run();
}

async function run(): Promise<void> {
  const mcp = spawnMcpServer();
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-codex', version: '0' },
  });
  mcp.notify('notifications/initialized', {});
  const listed = await mcp.request('tools/list', {}) as {
    tools: { name: string; description: string; inputSchema: unknown }[];
  };
  const names = listed.tools.map(tool => tool.name);
  const results: Record<string, unknown> = {};
  if (mode === 'parallel') {
    const [first, second] = await Promise.all([
      mcp.request('tools/call', { name: 'files_read', arguments: { path: 'AGENT.md' } }),
      mcp.request('tools/call', { name: 'files_read', arguments: { path: 'HEARTBEAT.md' } }),
    ]);
    results['AGENT.md'] = first;
    results['HEARTBEAT.md'] = second;
  } else {
    for (const path of ['AGENT.md', 'HEARTBEAT.md', 'POLICY.md', 'MEMORY.md']) {
      results[path] = await mcp.request('tools/call', {
        name: 'files_read',
        arguments: { path },
      });
    }
    if (names.includes('search_notes')) {
      results['search_notes'] = await mcp.request('tools/call', {
        name: 'search_notes',
        arguments: { query: 'anything' },
      });
    }
    results['unknown'] = await mcp.request('tools/call', {
      name: 'not_a_tool',
      arguments: {},
    }).catch(error => ({ rpcError: String(error) }));
  }
  const finalMessage = JSON.stringify({
    promptHead: prompt.split('\n')[0],
    promptHasPreamble: prompt.includes('MCP server "sharedos"'),
    tools: names,
    results,
  });
  writeFileSync(outputPath, `${finalMessage}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: finalMessage },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 },
  })}\n`);
  mcp.close();
  process.exit(0);
}

function spawnMcpServer() {
  const block = /\[mcp_servers\.sharedos\]\n([\s\S]*?)\n\n/.exec(config)?.[1] ?? '';
  const command = JSON.parse(/command = (".*")/.exec(block)![1]!) as string;
  const args = JSON.parse(/args = (\[.*\])/.exec(block)![1]!) as string[];
  const envBlock = /\[mcp_servers\.sharedos\.env\]\n([\s\S]*?)\n\n/.exec(config)?.[1] ?? '';
  const env: Record<string, string> = {};
  for (const line of envBlock.split('\n')) {
    const match = /^(\w+) = (".*")$/.exec(line);
    if (match) env[match[1]!] = JSON.parse(match[2]!) as string;
  }
  const child = spawn(command, args, {
    env: { ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}), ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let nextId = 0;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let buffered = '';
  child.stdout.on('data', chunk => {
    buffered += (chunk as Buffer).toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  return {
    request(method: string, params: unknown): Promise<unknown> {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method: string, params: unknown): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close(): void {
      child.stdin.end();
    },
  };
}
