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
- product adapters requiring private Aicoo/Pulse database access;
- credentials, API keys, or production configuration.

## Result Requirements

Every leaderboard result should include:

- submission manifest;
- git commit or artifact digest;
- benchmark suite and version;
- model/provider/version;
- run budget and tool surface;
- safety, utility, action, and network-specific metrics;
- failure notes for known invalid or partial runs.

## Anti-Overfitting Rule

Public tasks are for development and smoke validation. Official ranking should
use held-out tasks or sealed labels so submissions cannot tune directly against
the scoring set.
