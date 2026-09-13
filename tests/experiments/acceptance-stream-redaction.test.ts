import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Transform } from 'node:stream';
import test from 'node:test';

const helperUrl = new URL('../../scripts/experiments/acceptance-stream-redaction.mjs', import.meta.url);
const { createCredentialRedactionStream } = await import(helperUrl.href) as {
  createCredentialRedactionStream: () => Transform;
};
const fakeKey = 'sk-or-v1-fake_test_credential_0123456789';

async function redact(chunks: Array<string | Buffer>): Promise<string> {
  const stream = createCredentialRedactionStream();
  const output: Buffer[] = [];
  stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const ended = once(stream, 'end');
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await ended;
  return Buffer.concat(output).toString('utf8');
}

test('redacts a fake credential at every possible chunk boundary, including immediately after its prefix', async () => {
  const source = `before ${fakeKey} after\n`;
  for (let boundary = 0; boundary <= source.length; boundary += 1) {
    assert.equal(await redact([source.slice(0, boundary), source.slice(boundary)]), 'before [REDACTED] after\n',
      `chunk boundary ${boundary}`);
  }
});

test('handles byte-by-byte credentials, repeated credentials and EOF without a delimiter', async () => {
  const source = `{"one":"${fakeKey}","two":"${fakeKey}"}\n${fakeKey}`;
  assert.equal(await redact([...Buffer.from(source)].map(byte => Buffer.from([byte]))),
    '{"one":"[REDACTED]","two":"[REDACTED]"}\n[REDACTED]');
});

test('preserves UTF-8 split across bytes and ordinary unfinished prefix text', async () => {
  const source = `前后 café ${fakeKey}\nsk-or-v`;
  assert.equal(await redact([...Buffer.from(source)].map(byte => Buffer.from([byte]))),
    '前后 café [REDACTED]\nsk-or-v');
  assert.equal(await redact(['normal sk-or-', 'x value\n']), 'normal sk-or-x value\n');
});

test('flushes long noncredential lines promptly and suppresses unbounded credential tails', async () => {
  const stream = createCredentialRedactionStream();
  const output: string[] = [];
  stream.on('data', chunk => output.push(String(chunk)));
  const body = 'normal log contents '.repeat(100_000);
  stream.write(body);
  assert.equal(output.join(''), body);
  stream.write('sk-or-v1-');
  for (let index = 0; index < 100; index += 1) stream.write('x'.repeat(10_000));
  assert.equal(output.join(''), `${body}[REDACTED]`);
  const ended = once(stream, 'end');
  stream.end('\n');
  await ended;
  assert.equal(output.join(''), `${body}[REDACTED]\n`);
});

test('uses independent stream state for stdout and stderr', async () => {
  const first = createCredentialRedactionStream();
  const second = createCredentialRedactionStream();
  let firstText = '';
  let secondText = '';
  first.on('data', chunk => { firstText += String(chunk); });
  second.on('data', chunk => { secondText += String(chunk); });
  first.write('sk-or-v1-');
  second.write('ordinary stderr\n');
  const ended = [once(first, 'end'), once(second, 'end')];
  first.end('fake-secret\n');
  second.end();
  await Promise.all(ended);
  assert.equal(firstText, '[REDACTED]\n');
  assert.equal(secondText, 'ordinary stderr\n');
});
