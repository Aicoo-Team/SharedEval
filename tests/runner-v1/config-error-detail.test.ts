import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainSharedevalV1 } from '../../src/runner/v1/sharedeval-cli.js';

const yaml = (budget: string) => `apiVersion: sharedeval-run/v2
kind: RunConfig
model:
  provider: azure-openai
  endpoint: https://x.cognitiveservices.azure.com/openai/v1
  deployment: d
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
benchmark:
  dataset: pact-net
  tasks: { kind: all }
workflow:
  mode: multi
  protocol: files
  maxTicks: 5
  stopWhen: all-terminal
budget:
${budget}
output:
  directory: runs/x
`;

test('an invalid config says which field and why', async () => {
  // The bare "configuration is invalid" cost two launched queues: every run
  // failed instantly, three tries each, and the message named nothing. A
  // rejection nobody can act on is close to no rejection at all.
  const dir = mkdtempSync(join(tmpdir(), 'cfg-detail-'));
  const path = join(dir, 'bad.yaml');
  writeFileSync(path, yaml('  maxToolCalls: 400\n  maxRuntimeMs: 900000\n'));
  await assert.rejects(
    () => mainSharedevalV1(['multi', '--config', path, '--check']),
    (error: Error) => {
      assert.match(error.message, /budget\.maxToolCalls/);
      assert.match(error.message, /budget\.maxRuntimeMs/);
      assert.match(error.message, /128/);
      return true;
    },
  );
});
