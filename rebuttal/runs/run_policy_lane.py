#!/usr/bin/env python3
"""Plan or launch the P0-P7 policy lane on Pulse's contact_agent engine."""

from __future__ import annotations

import os
from pathlib import Path
import sys


SWEEP = (
    Path(__file__).resolve().parents[3]
    / "pulse/research/scripts/rebuttal/run_experiments.py"
)
BLOCKS = "policy,replications"
RESERVED_OPTIONS = {"--blocks"}

HELP = f"""\
usage: run_policy_lane.py [Pulse orchestrator options]

Plan P0-P7 plus the P1/P2/P6/P7 replication lane through Pulse's real
requester -> contact_agent -> responder execution path.

Fixed selection:
  --blocks {BLOCKS}

The default is plan-only. Paid execution requires the exact printed plan SHA
and all explicit database/policy/cost acknowledgements. --blocks cannot be
overridden here; model pairs remain user-controllable.

Examples:
  python3 rebuttal/runs/run_policy_lane.py --dry-run
  python3 rebuttal/runs/run_policy_lane.py --profile defender
  python3 rebuttal/runs/run_policy_lane.py --model-pairs baseline,defender-deepseek

For the complete forwarded option list:
  python3 ../pulse/research/scripts/rebuttal/run_experiments.py --help
"""


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    override = next(
        (
            argument.split("=", 1)[0]
            for argument in arguments
            if argument.split("=", 1)[0] in RESERVED_OPTIONS
        ),
        None,
    )
    if override:
        print(
            f"run_policy_lane.py: error: {override} is fixed by this lane; "
            "use run_experiments.py for a custom matrix",
            file=sys.stderr,
        )
        return 2
    if any(argument in {"-h", "--help"} for argument in arguments):
        print(HELP, end="")
        return 0

    command = [
        sys.executable,
        str(SWEEP),
        "--blocks",
        BLOCKS,
        *arguments,
    ]
    os.execv(sys.executable, command)
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
