import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getPactPolicySha256V1,
  getPactPolicyTextV1,
  PACT_POLICY_FILES_V1,
} from '../../src/runner/v1/prompt.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const frozenPolicies = {
  A_LONG_GENERIC: {
    file: 'A_LONG_GENERIC.md',
    words: 361,
    sha256: '65cce34657ad6392db5d5d14d4b6675e9b054bc9237849b0b47fabe536c12b1a',
  },
  A_CATEGORY_ONLY: {
    file: 'A_CATEGORY_ONLY.md',
    words: 361,
    sha256: 'ecf478b6c32b71ed5fa0ee213bba2f78f42e0d0cd404f8708878440001aee67c',
  },
  A_CATEGORY_EXAMPLES: {
    file: 'A_CATEGORY_EXAMPLES.md',
    words: 361,
    sha256: '13eb6235ae091949299fa25a439e9b6d151a1060ecb7059fd4b25a3012036f76',
  },
  REL_R0: {
    file: 'REL_R0.md',
    words: 199,
    sha256: 'a0cc484cb3501f97f9448b9a371d97cc8febf001c77215444d75115aabd67cf9',
  },
  REL_R1: {
    file: 'REL_R1.md',
    words: 296,
    sha256: 'f309af74768a703dc97afe2bfd88a4c38b211f54ee0be7b27451ea41b9dd5658',
  },
  REL_R2: {
    file: 'REL_R2.md',
    words: 309,
    sha256: '5b25aa41daab97d12b6a5de24852a749278ddf8765cd8322de3b314b6805cdd9',
  },
  REL_R3: {
    file: 'REL_R3.md',
    words: 326,
    sha256: '662899272f9be9fcd101a2359a711797fe6f3d1bbbae6fff803fe9d1120f311a',
  },
  REL_R4: {
    file: 'REL_R4.md',
    words: 332,
    sha256: '618274af164e736bd6bbb9660c7344f0ba0ebdccda8eaf4c5e351c480e55bcee',
  },
} as const;

const submittedPolicies = {
  D2_SUBMITTED: {
    file: 'D2_SUBMITTED.md',
    whitespaceSegments: 323,
    loadedSha256: 'e5728f3920c72fd193a28d54f9d50b3837449d0ab2e29b22a651589e810e694f',
    rawSha256: 'a213e556fc4262c72ed3a1a12a9bd68c1ef006acbad0e5337122dbb897665f30',
  },
  D3_SUBMITTED: {
    file: 'D3_SUBMITTED.md',
    whitespaceSegments: 421,
    loadedSha256: '26aff1278836c4fa10cb54dec33a3e0cfd42669351de67e22006f71c313bfa4c',
    rawSha256: '4ef50759b20c7546792c8a35d8f6a5927ef4b3e6c27bedc50c342538756d9a32',
  },
  D4_SUBMITTED: {
    file: 'D4_SUBMITTED.md',
    whitespaceSegments: 454,
    loadedSha256: '37a58e6c7e1e2325e16d1b680ce5bb3f15e9d6414439b583ea5fb60209b7e434',
    rawSha256: '2ed591ba7e4348baa096cb4948b32c9d39dbfb43057785920b5474f7cf3cc184',
  },
  D5_SUBMITTED: {
    file: 'D5_SUBMITTED.md',
    whitespaceSegments: 455,
    loadedSha256: 'f6b17d98cb9844be15538a063dc182fe50c99f4e9f033067708070851c0f9b0e',
    rawSha256: '5852239454b61a694f1e18899f08bf898c30212a790c0a57055f6fb184f61850',
  },
} as const;

test('freezes matched ablation and relationship policy text by hash', () => {
  for (const [policy, expected] of Object.entries(frozenPolicies)) {
    const policyId = policy as keyof typeof frozenPolicies;
    const text = getPactPolicyTextV1(policyId);
    assert.equal(PACT_POLICY_FILES_V1[policyId], expected.file);
    assert.equal(text.split(/\s+/u).length, expected.words);
    assert.equal(getPactPolicySha256V1(policyId), expected.sha256);
  }
});

test('freezes submitted policy files byte-for-byte and after runner trimming', () => {
  for (const [policy, expected] of Object.entries(submittedPolicies)) {
    const policyId = policy as keyof typeof submittedPolicies;
    const raw = readFileSync(
      join(repoRoot, 'pact_pair', 'policies', expected.file),
      'utf8',
    );
    const text = getPactPolicyTextV1(policyId);

    assert.equal(PACT_POLICY_FILES_V1[policyId], expected.file);
    assert.equal(raw.trim(), text);
    assert.equal(text.split(/\s+/u).length, expected.whitespaceSegments);
    assert.equal(getPactPolicySha256V1(policyId), expected.loadedSha256);
    assert.equal(
      createHash('sha256').update(raw, 'utf8').digest('hex'),
      expected.rawSha256,
    );
  }
});

test('keeps the matched ablation contrasts semantically distinct', () => {
  const generic = getPactPolicyTextV1('A_LONG_GENERIC');
  const categories = getPactPolicyTextV1('A_CATEGORY_ONLY');
  const examples = getPactPolicyTextV1('A_CATEGORY_EXAMPLES');

  assert.doesNotMatch(generic, /\*\*Personal finance\*\*/);
  assert.match(categories, /\*\*Personal finance\*\* is a restricted category/);
  assert.doesNotMatch(categories, /bank account balances/);
  assert.match(examples, /bank account balances, investment portfolios/);
});
