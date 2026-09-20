import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('tracked text assets are checked out with canonical LF bytes', async () => {
  // Regression: core.autocrlf changed byte-addressed assets and invalidated their registry digests.
  const attributes = await readFile(resolve(repositoryRoot, '.gitattributes'), 'utf8');

  assert.match(attributes, /^\* text=auto eol=lf$/mu);
});
