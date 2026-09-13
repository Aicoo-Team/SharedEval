import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const prefix = 'sk-or-v1-';
const replacement = '[REDACTED]';

/** Redacts credential-shaped text across arbitrary chunks without buffering lines. */
export function createCredentialRedactionStream() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let withinCredential = false;

  function consume(text, final = false) {
    pending += text;
    let output = '';
    while (pending.length > 0) {
      if (withinCredential) {
        const delimiter = pending.search(/[^A-Za-z0-9_-]/);
        if (delimiter < 0) {
          pending = '';
          break;
        }
        pending = pending.slice(delimiter);
        withinCredential = false;
      }
      const start = pending.indexOf(prefix);
      if (start >= 0) {
        output += pending.slice(0, start) + replacement;
        pending = pending.slice(start + prefix.length);
        withinCredential = true;
        continue;
      }
      // Retain only a potential prefix suffix, never an entire unfinished line.
      let retained = 0;
      if (!final) {
        for (let length = 1; length < prefix.length; length += 1) {
          if (pending.endsWith(prefix.slice(0, length))) retained = length;
        }
      }
      output += pending.slice(0, pending.length - retained);
      pending = pending.slice(pending.length - retained);
      break;
    }
    return output;
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      callback(null, consume(decoder.write(buffer)));
    },
    flush(callback) {
      callback(null, consume(decoder.end(), true));
    },
  });
}
