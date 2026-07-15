import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { parsePactManifestYamlV1 } from '../../src/protocol/v1/index.js';
import { validManifestV1 } from './fixtures.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parses the canonical manifest example from the repository', () => {
  const source = readFileSync(
    join(repoRoot, 'examples/submissions/typescript-basic/pact.yaml'),
    'utf8',
  );
  const manifest = parsePactManifestYamlV1(source);
  assert.equal(manifest.id, 'typescript-basic');
  assert.equal(manifest.track, 'pact-pair');
});

test('parses one strict YAML manifest without interpolating environment syntax', () => {
  const manifest = {
    ...validManifestV1,
    declarations: {
      ...validManifestV1.declarations,
      notes: '${OPENAI_API_KEY}',
    },
  };
  const parsed = parsePactManifestYamlV1(stringify(manifest));
  assert.equal(parsed.declarations.notes, '${OPENAI_API_KEY}');
});

test('rejects duplicate YAML keys', () => {
  const source = stringify(validManifestV1).replace(
    'apiVersion: pact-bench/v1',
    'apiVersion: pact-bench/v1\napiVersion: pact-bench/v1',
  );
  assert.throws(() =>
    parsePactManifestYamlV1(source),
  );
});

test('rejects multiple YAML documents', () => {
  const source = stringify(validManifestV1);
  assert.throws(() =>
    parsePactManifestYamlV1(`${source}\n---\n${source}`),
  );
});

test('rejects YAML aliases and custom tags', () => {
  const source = stringify(validManifestV1);
  const aliasSource = source
    .replace('organization: Example Research Group', 'organization: &org Example Research Group')
    .replace('provider: openai', 'provider: *org');
  const customTagSource = source.replace(
    'name: TypeScript policy baseline',
    'name: !env TypeScript policy baseline',
  );

  assert.throws(() => parsePactManifestYamlV1(aliasSource));
  assert.throws(() => parsePactManifestYamlV1(customTagSource));
});

test('rejects oversized manifests', () => {
  assert.throws(() => parsePactManifestYamlV1(`notes: ${'x'.repeat(256 * 1024)}\n`));
});
