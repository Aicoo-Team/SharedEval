import { spawnSync } from 'node:child_process';

// Preserve the repository's existing validation and test commands in one entry point.
for (const script of ['validate', 'type-check', 'test']) {
  const manager = process.env.npm_execpath;
  const command = manager ? process.execPath : 'npm';
  const args = manager ? [manager, 'run', script] : ['run', script];
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
