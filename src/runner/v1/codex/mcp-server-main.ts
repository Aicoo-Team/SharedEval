import { connect } from 'node:net';
import process from 'node:process';
import { CODEX_BRIDGE_SOCKET_ENV_V1 } from './bridge-protocol.js';
import { createCodexBridgeMcpServerV1 } from './mcp-server.js';

/**
 * Process entry for the bridge MCP server. Codex spawns this over stdio; the
 * driver that launched Codex tells it where the bridge socket lives through
 * SHAREDEVAL_CODEX_BRIDGE_SOCKET. Nothing else is read from the environment
 * and no model credential ever reaches this process.
 */
const socketPath = process.env[CODEX_BRIDGE_SOCKET_ENV_V1];
if (!socketPath) {
  process.stderr.write(`${CODEX_BRIDGE_SOCKET_ENV_V1} is not set\n`);
  process.exit(2);
}

const server = createCodexBridgeMcpServerV1({
  input: process.stdin,
  output: process.stdout,
  connectBridge: () => new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  }),
});

server.done.then(
  () => process.exit(0),
  error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
