import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syncDirectoryV1 } from '../../src/runner/v1/durable-files.js';

test('directory durability degrades only when the platform cannot sync directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sharedeval-directory-sync-'));
  try {
    // Regression: Node returns EPERM for directory fsync on Windows.
    await syncDirectoryV1(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
