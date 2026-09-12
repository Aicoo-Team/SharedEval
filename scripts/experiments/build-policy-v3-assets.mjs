#!/usr/bin/env node
// Builds the 28 static PACT-Pair policy-v3 assets (D0–D6 × R0–R3) from the
// single authoritative text dataset/pact-pair/policies/PROMPTS_D0-D6.md and
// registers them in dataset/shared-eval/workspaces/v1/registry.json.
//
// Each asset = Verified-caller head (identity sentence swapped per requester)
// + `---` + the policy body, exactly as the responder reads POLICY.md. The
// runner never concatenates at runtime; one asset is one POLICY.md.
//
// Usage: node scripts/experiments/build-policy-v3-assets.mjs [--check]
//   --check  verify the committed files/registry match the source (no writes)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const promptsPath = 'dataset/pact-pair/policies/PROMPTS_D0-D6.md';
const registryPath = 'dataset/shared-eval/workspaces/v1/registry.json';
const text = readFileSync(join(repoRoot, promptsPath), 'utf8');

// --- identity sentences (R0–R4 listed at the top of the prompts file) -------
const identity = {};
for (const m of text.matchAll(/^- (R[0-4]): (.+)$/gm)) identity[m[1]] = m[2].trim();
for (const r of ['R0', 'R1', 'R2', 'R3']) {
  if (!identity[r]) throw new Error(`identity sentence for ${r} not found`);
}
const r1Sentence = identity.R1;

// --- policy blocks -----------------------------------------------------------
const blocks = new Map();
for (const m of text.matchAll(/^## (D[0-6]) — [^\n]*\n\n```\n([\s\S]*?)\n```/gm)) {
  blocks.set(m[1], m[2]);
}
for (const d of ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6']) {
  if (!blocks.has(d)) throw new Error(`policy block ${d} not found`);
}

const words = s => s.split(/\s+/).filter(Boolean).length;
const sha256 = b => createHash('sha256').update(b).digest('hex');

let failures = 0;
const fail = msg => { failures += 1; console.error(`FAIL ${msg}`); };
const emit = (path, content) => {
  const abs = join(repoRoot, path);
  if (check) {
    if (!existsSync(abs)) return fail(`${path} missing`);
    if (readFileSync(abs, 'utf8') !== content) return fail(`${path} differs from source`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

const registry = JSON.parse(readFileSync(join(repoRoot, registryPath), 'utf8'));
const byId = new Map(registry.assets.map(a => [a.id, a]));
const generated = [];

for (const [d, block] of blocks) {
  const k = d.slice(1);
  if (!block.includes(r1Sentence)) throw new Error(`${d} block does not contain the R1 identity sentence`);
  const sep = block.indexOf('\n---\n');
  const body = sep === -1 ? '' : block.slice(sep + '\n---\n'.length);
  if (d === 'D0' && sep !== -1) throw new Error('D0 must have no body');
  if (d !== 'D0' && sep === -1) throw new Error(`${d} must have a --- separator`);
  const bodyWords = words(body);
  if ((d === 'D2' || d === 'D6') && bodyWords !== 298) {
    throw new Error(`${d} body must be exactly 298 words, got ${bodyWords}`);
  }
  for (const r of ['R0', 'R1', 'R2', 'R3']) {
    const j = r.slice(1);
    const content = `${block.replace(r1Sentence, identity[r])}\n`;
    if (r !== 'R1' && content.includes(r1Sentence)) throw new Error(`${d}/${r} still names R1`);
    if (!content.includes(identity[r])) throw new Error(`${d}/${r} lacks its identity`);
    const bytes = Buffer.from(content, 'utf8');
    const sourcePath = `dataset/pact-pair/policies/${d}_${r}.md`;
    const assetPath = `policies/pact-pair-v3/d${k}/r${j}/1.0.0/POLICY.md`;
    emit(sourcePath, content);
    emit(`dataset/shared-eval/workspaces/v1/${assetPath}`, content);
    const entry = {
      id: `policies/pact-pair-v3/d${k}-r${j}`,
      version: '1.0.0',
      actorRoles: ['responder'],
      sourcePath: assetPath,
      aliases: [`pact:${sourcePath}`],
      status: 'active',
      compatibleDatasets: ['pact-pair'],
      compatibleWorkflowIds: ['files-multi', 'files-single'],
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      provenance: { kind: 'exact', sourcePath, sourceSha256: sha256(bytes) },
    };
    generated.push(entry);
    console.log(`${entry.id}\tbody=${bodyWords}w\tbytes=${entry.byteLength}\t${entry.sha256.slice(0, 12)}`);
  }
}

for (const entry of generated) {
  const existing = byId.get(entry.id);
  if (check) {
    if (!existing) { fail(`${entry.id} not registered`); continue; }
    if (JSON.stringify(existing) !== JSON.stringify(entry)) fail(`${entry.id} registry entry differs`);
    continue;
  }
  byId.set(entry.id, entry);
}
if (!check) {
  registry.assets = [...byId.values()].sort((a, b) =>
    `${a.id}@${a.version}` < `${b.id}@${b.version}` ? -1 : 1);
  writeFileSync(join(repoRoot, registryPath), `${JSON.stringify(registry, null, 2)}\n`);
}
if (failures) { console.error(`${failures} check failure(s)`); process.exit(1); }
console.log(`${check ? 'verified' : 'wrote'} ${generated.length} policy-v3 assets`);
