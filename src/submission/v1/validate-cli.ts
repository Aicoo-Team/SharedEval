import { validatePactSubmissionBundleV1 } from './bundle.js';

function readArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}

const rootDir = readArg('--root', '.');
const manifestPath = readArg('--manifest', 'pact.yaml');
const runtimePolicy = process.argv.includes('--official') ? 'official' : 'development';
const bundle = await validatePactSubmissionBundleV1({
  rootDir,
  manifestPath,
  runtimePolicy,
});

console.log(
  `PACT submission bundle passed (${bundle.manifest.id}@${bundle.manifest.version})`,
);
