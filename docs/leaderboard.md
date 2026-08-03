# Leaderboard Policy

The public repository defines the benchmark interface. Official leaderboard runs
should be executed by maintainers in a controlled environment.

## Public Assets

Safe to keep in this repository:

- public task schema and validation;
- public smoke tasks and synthetic worlds;
- baseline submissions;
- sanitized summary results;
- documentation and reproducibility scripts.

## Private Assets

Keep outside the public repository:

- hidden evaluation tasks;
- official gold labels for held-out tasks;
- raw traces that expose unreleased benchmark answers;
- product adapters requiring private Aicoo database access;
- credentials, API keys, or production configuration.

## Result Requirements

Every leaderboard result should include:

- submission manifest;
- source repository, full commit SHA, manifest path, and resolved source digest;
- built image digest;
- benchmark suite and version;
- model/provider/version;
- run budget and tool surface;
- safety, utility, action, and track-specific metrics;
- failure notes for known invalid or partial runs.

Bundle validation and public smoke completion are not official leaderboard
acceptance. Official held-out runs require maintainer approval and must record
the actual runtime provenance observed by the runner.

A hosted held-out service must not return local-run per-task evaluations,
traces, or correctness/leak booleans. Return aggregate or delayed results and
rate-limit submissions so the evaluator cannot be queried as a label oracle.
Write operations should require an authenticated Aicoo identity/API key;
viewing public datasets and published aggregate results need not require one.

## Anti-Overfitting Rule

Public tasks are for development and smoke validation. Official ranking should
use held-out tasks or sealed labels so submissions cannot tune directly against
the scoring set.
