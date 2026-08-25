import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadAndValidatePr31Evidence } from './schema.js';

const evidenceRoot = fileURLToPath(new URL('.', import.meta.url));

function parseArguments(args: string[]): {
  manifestPath: string;
  aggregatesPath: string;
  json: boolean;
} {
  let manifestPath = resolve(evidenceRoot, 'manifest.json');
  let aggregatesPath = resolve(evidenceRoot, 'aggregates.json');
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--manifest' || argument === '--aggregates') {
      const value = args[index + 1];
      if (!value) throw new Error('invalid validator arguments');
      if (argument === '--manifest') manifestPath = resolve(value);
      else aggregatesPath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error('invalid validator arguments');
  }
  return { manifestPath, aggregatesPath, json };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const { manifest, aggregates } = loadAndValidatePr31Evidence(
    options.manifestPath,
    options.aggregatesPath,
  );
  const executable = manifest.configurations.filter(
    row => row.disposition === 'executable-current-main',
  ).length;
  const summary = {
    aggregateRecords: aggregates.records.length,
    completeness: manifest.completeness,
    configurations: manifest.configurations.length,
    executableConfigurations: executable,
    historicalOnlyConfigurations: manifest.configurations.length - executable,
    protocol: manifest.protocol,
    sourceHead: manifest.source.head,
    status: manifest.status,
  };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(summary)}\n`
      : 'PR 31 historical evidence is valid.\n',
  );
} catch {
  process.stderr.write('Manifest validation failed.\n');
  process.exitCode = 1;
}
