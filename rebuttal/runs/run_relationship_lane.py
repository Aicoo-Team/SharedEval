#!/usr/bin/env python3
"""Plan or launch the relationship-memory lane on Pulse contact_agent."""

from __future__ import annotations

import os
from pathlib import Path
import sys


SWEEP = (
    Path(__file__).resolve().parents[3]
    / "pulse/research/scripts/rebuttal/run_experiments.py"
)
BLOCKS = "relationship"
RESERVED_OPTIONS = {"--blocks"}

HELP = f"""\
usage: run_relationship_lane.py [Pulse orchestrator options]

Plan R0-R4 relationship-context cells through Pulse's real contact_agent path.
This lane currently keeps P2 fixed and varies the seeded relationship context;
requester-specific policy and MCC remain separate structural lanes.

Fixed selection:
  --blocks {BLOCKS}

The default is plan-only. --blocks cannot be overridden; model pairs remain
user-controllable.

Examples:
  python3 rebuttal/runs/run_relationship_lane.py --dry-run
  python3 rebuttal/runs/run_relationship_lane.py --profile minimal

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
            f"run_relationship_lane.py: error: {override} is fixed by this "
            "lane; use run_experiments.py for a custom matrix",
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
