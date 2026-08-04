# Experiment Policy Registry

The run-config policy ID is the stable experiment identifier. Do not reuse
`D3`–`D5` for relationship policies: those IDs already name prompt-injection
defenses in the public runner.

Hashes below are SHA-256 over the exact policy text loaded by the runner after
trimming leading and trailing whitespace. The runner exposes the same digest
through `getPactPolicySha256V1`.

## Submitted prompt policies

The public PACT `D2`–`D5` files are later expanded variants and remain
unchanged for backward compatibility. Use the following IDs when reproducing
the policies described in the submitted paper:

| Policy ID | Pulse source | Words | Loaded-text SHA-256 | Source history |
|---|---|---:|---|---|
| `D2_SUBMITTED` | `research/configs/alex/POLICY_M2.md` | 323 | `e5728f3920c72fd193a28d54f9d50b3837449d0ab2e29b22a651589e810e694f` | Last changed 2026-04-29, Pulse commit `63989738c` |
| `D3_SUBMITTED` | `research/configs/alex/POLICY_M3.md` | 421 | `26aff1278836c4fa10cb54dec33a3e0cfd42669351de67e22006f71c313bfa4c` | Last changed 2026-05-06, Pulse commit `b99b8fb10` |
| `D4_SUBMITTED` | `research/configs/alex/POLICY_M4.md` | 454 | `37a58e6c7e1e2325e16d1b680ce5bb3f15e9d6414439b583ea5fb60209b7e434` | Last changed 2026-05-06, Pulse commit `b99b8fb10` |
| `D5_SUBMITTED` | `research/configs/alex/POLICY_M5.md` | 456¹ | `f6b17d98cb9844be15538a063dc182fe50c99f4e9f033067708070851c0f9b0e` | Last changed 2026-05-06, Pulse commit `b99b8fb10` |

The files are byte-for-byte copies from the clean Pulse working tree audited
on 2026-07-28. The dates above establish that the checked-in source predates
the submission, but the `*_SUBMITTED` name records the rebuttal's provenance
claim rather than asserting that these PACT filenames existed at submission.
`D2_SUBMITTED` is the relationship-agnostic baseline and is valid under either
category or relationship grading.

¹ Locale-aware `wc -w` reports 456 for `D5_SUBMITTED`; a Unicode whitespace
split reports 455 because the warning-sign heading is tokenized differently.
The hash, rather than either word counter, is authoritative.

## Matched specificity ablation

| Policy ID | Meaning | Words | SHA-256 |
|---|---|---:|---|
| `A_LONG_GENERIC` | Strict, verbose generic privacy rule; no category names or item examples | 361 | `65cce34657ad6392db5d5d14d4b6675e9b054bc9237849b0b47fabe536c12b1a` |
| `A_CATEGORY_ONLY` | Same-length policy with permitted/restricted category names and no item examples | 361 | `ecf478b6c32b71ed5fa0ee213bba2f78f42e0d0cd404f8708878440001aee67c` |
| `A_CATEGORY_EXAMPLES` | Same-length policy with category names and item-level examples | 361 | `13eb6235ae091949299fa25a439e9b6d151a1060ecb7059fd4b25a3012036f76` |

The prespecified contrasts are:

1. `A_LONG_GENERIC` vs. `A_CATEGORY_ONLY`: category naming at matched length.
2. `A_CATEGORY_ONLY` vs. `A_CATEGORY_EXAMPLES`: incremental item examples.
3. `A_LONG_GENERIC` vs. `A_CATEGORY_EXAMPLES`: combined category grounding.

All three use the D2 category-level gold contract. None is a short-specific
policy; their matched length is intentional.

## Relationship-tailored policies

| Policy ID | Required requester | Words | SHA-256 |
|---|---|---:|---|
| `REL_R0` | R0 — stranger | 199 | `a0cc484cb3501f97f9448b9a371d97cc8febf001c77215444d75115aabd67cf9` |
| `REL_R1` | R1 — colleague | 296 | `f309af74768a703dc97afe2bfd88a4c38b211f54ee0be7b27451ea41b9dd5658` |
| `REL_R2` | R2 — CEO delegate | 309 | `5b25aa41daab97d12b6a5de24852a749278ddf8765cd8322de3b314b6805cdd9` |
| `REL_R3` | R3 — close friend | 326 | `662899272f9be9fcd101a2359a711797fe6f3d1bbbae6fff803fe9d1120f311a` |
| `REL_R4` | R4 — investor / board observer | 332 | `618274af164e736bd6bbb9660c7344f0ba0ebdccda8eaf4c5e351c480e55bcee` |

These files are exact copies of the active Pulse `POLICY_D3_R0.md` through
`POLICY_D3_R4.md` texts. A relationship policy is valid only with its matching
requester and `benchmark.gradingMode: relationship`; config parsing and direct
task loading both enforce that pairing. These policies and gold labels have
only been validated for QA, so the runner also rejects action-task configs for
`REL_R0`–`REL_R4`.

## Grading modes

- `category` uses `categories[].expected_m*` and never replaces those labels
  with requester-conditioned relationship judgments.
- `relationship` uses an R0–R4 relationship label when one exists and falls
  back to the selected policy's category-level expectation otherwise.

Every generated experiment config should write `gradingMode` explicitly even
though the parser defaults it to `category`.
