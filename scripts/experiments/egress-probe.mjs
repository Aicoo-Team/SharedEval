#!/usr/bin/env node
/**
 * Egress probe for one experiment cell. Runs inside the runner container
 * BEFORE any model spend and proves the sandbox shape:
 *
 *   1. direct egress (no proxy) is blocked;
 *   2. proxied egress to a non-allowlisted host is rejected by the proxy;
 *   3. proxied egress to the model endpoint host succeeds (CONNECT <host>:443).
 *
 * Machine-readable JSON on stdout; exit 0 only when all three hold. The
 * endpoint check retries, which doubles as wait-for-proxy-startup. Each
 * attempt runs in a child node process so proxy environment variables
 * (NODE_USE_ENV_PROXY / HTTPS_PROXY) are controlled per attempt.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EGRESS_PROBE_API_VERSION_V1 = 'sharedeval-egress-probe/v1';
export const DEFAULT_NON_ALLOWLISTED_HOST_V1 = 'example.com';
const ATTEMPT_TIMEOUT_MS = 10_000;

const CHILD_SCRIPT = [
  'const [url, timeoutRaw] = process.argv.slice(1);',
  'try {',
  "  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Number(timeoutRaw)) });",
  "  process.stdout.write(JSON.stringify({ kind: 'response', status: response.status }));",
  '} catch (error) {',
  '  const cause = error && error.cause;',
  '  const detail = [error && error.name, cause && (cause.code || cause.message), error && error.message]',
  "    .filter(Boolean).join(': ').slice(0, 200);",
  "  process.stdout.write(JSON.stringify({ kind: 'fetch-failed', detail }));",
  '}',
].join('\n');

/**
 * One fetch attempt in a child process. Outcomes are total:
 *   { kind: 'response', status }      — TCP/TLS/HTTP reached the target;
 *   { kind: 'fetch-failed', detail }  — the request could not complete;
 *   { kind: 'probe-error', detail }   — the probe itself malfunctioned
 * A probe-error never satisfies any expectation (fail closed).
 */
export function spawnFetchAttemptV1({ url, proxyUrl, timeoutMs = ATTEMPT_TIMEOUT_MS }) {
  const environment = { PATH: process.env.PATH ?? '' };
  if (proxyUrl) {
    environment.NODE_USE_ENV_PROXY = '1';
    environment.HTTPS_PROXY = proxyUrl;
    environment.HTTP_PROXY = proxyUrl;
  }
  return new Promise(resolvePromise => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', CHILD_SCRIPT, url, String(timeoutMs)],
      { env: environment, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.on('error', () => {
      resolvePromise({ kind: 'probe-error', detail: 'failed to spawn probe child process' });
    });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.kind === 'response' || parsed.kind === 'fetch-failed')) {
          resolvePromise(parsed);
          return;
        }
      } catch {
        // fall through to probe-error
      }
      resolvePromise({
        kind: 'probe-error',
        detail: `unparseable probe child output: ${stdout.slice(0, 200)}`,
      });
    });
  });
}

export async function runEgressProbeV1(options) {
  const {
    endpointHost,
    proxyUrl,
    nonAllowlistedHost = DEFAULT_NON_ALLOWLISTED_HOST_V1,
    attempt = spawnFetchAttemptV1,
    endpointAttempts = 15,
    retryDelayMs = 2_000,
    sleep = milliseconds => new Promise(resolvePromise => {
      setTimeout(resolvePromise, milliseconds);
    }),
  } = options ?? {};
  if (typeof endpointHost !== 'string' || endpointHost.length === 0) {
    throw new Error('egress probe requires an endpoint host');
  }
  if (typeof proxyUrl !== 'string' || proxyUrl.length === 0) {
    throw new Error('egress probe requires a proxy url');
  }
  if (endpointHost === nonAllowlistedHost) {
    throw new Error('egress probe non-allowlisted host must differ from the endpoint host');
  }
  if (!Number.isInteger(endpointAttempts) || endpointAttempts < 1) {
    throw new Error('egress probe endpointAttempts must be a positive integer');
  }

  const endpointUrl = `https://${endpointHost}/`;
  const nonAllowlistedUrl = `https://${nonAllowlistedHost}/`;

  // Check 3 first, with retries: it also waits out proxy container startup.
  let endpointOutcome = { kind: 'probe-error', detail: 'not attempted' };
  for (let attemptIndex = 0; attemptIndex < endpointAttempts; attemptIndex += 1) {
    endpointOutcome = await attempt({ url: endpointUrl, proxyUrl });
    if (endpointOutcome.kind === 'response') break;
    if (attemptIndex + 1 < endpointAttempts) await sleep(retryDelayMs);
  }
  const nonAllowlistedOutcome = await attempt({ url: nonAllowlistedUrl, proxyUrl });
  const directOutcome = await attempt({ url: endpointUrl });

  const directEgressBlocked = directOutcome.kind === 'fetch-failed';
  const nonAllowlistedEgressBlocked = nonAllowlistedOutcome.kind === 'fetch-failed';
  const modelEndpointReachable = endpointOutcome.kind === 'response';
  const pass = directEgressBlocked && nonAllowlistedEgressBlocked && modelEndpointReachable;
  return Object.freeze({
    apiVersion: EGRESS_PROBE_API_VERSION_V1,
    endpointHost,
    proxyUrl,
    nonAllowlistedHost,
    // These three names mirror experimentEgressProbeV1Schema
    // (src/experiments/v1/contracts.ts) for verbatim provenance lifting.
    directEgressBlocked,
    nonAllowlistedEgressBlocked,
    modelEndpointReachable,
    pass,
    checks: Object.freeze([
      Object.freeze({
        id: 'direct-egress-blocked',
        url: endpointUrl,
        proxied: false,
        expectation: 'blocked',
        ok: directEgressBlocked,
        outcome: directOutcome,
      }),
      Object.freeze({
        id: 'proxied-non-allowlisted-rejected',
        url: nonAllowlistedUrl,
        proxied: true,
        expectation: 'blocked',
        ok: nonAllowlistedEgressBlocked,
        outcome: nonAllowlistedOutcome,
      }),
      Object.freeze({
        id: 'proxied-endpoint-reachable',
        url: endpointUrl,
        proxied: true,
        expectation: 'reachable',
        ok: modelEndpointReachable,
        outcome: endpointOutcome,
      }),
    ]),
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--endpoint-host') {
      options.endpointHost = value;
      index += 1;
    } else if (argument === '--proxy-url') {
      options.proxyUrl = value;
      index += 1;
    } else if (argument === '--non-allowlisted-host') {
      options.nonAllowlistedHost = value;
      index += 1;
    } else {
      throw new Error(
        'usage: egress-probe.mjs --endpoint-host <host> --proxy-url <url> '
        + '[--non-allowlisted-host <host>]',
      );
    }
  }
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const report = await runEgressProbeV1(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.pass ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
