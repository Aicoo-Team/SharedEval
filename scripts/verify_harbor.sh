#!/usr/bin/env bash
# Offline deterministic parity check for the P0 Harbor backend, plus a
# denied-egress probe that proves Harbor-run containers have no network.
#
# Prerequisites: Docker (daemon running) and Harbor 0.5.0
# (uv tool install harbor==0.5.0).
#
# By default missing prerequisites SKIP the check (local convenience). Set
# PACT_HARBOR_SMOKE_REQUIRE=1 (as CI does) to FAIL instead of skipping when
# the prerequisites are expected to be present.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
ROOT="$(pwd)"
REQUIRED_HARBOR_VERSION="0.5.0"

missing_prerequisite() {
  if [ "${PACT_HARBOR_SMOKE_REQUIRE:-0}" = "1" ]; then
    echo "FAIL: $1 (PACT_HARBOR_SMOKE_REQUIRE=1)"
    exit 1
  fi
  echo "SKIP: $1"
  exit 0
}

if ! command -v docker >/dev/null 2>&1; then
  missing_prerequisite "Docker is not installed"
fi
if ! docker info >/dev/null 2>&1; then
  missing_prerequisite "Docker daemon is not running"
fi
if ! command -v harbor >/dev/null 2>&1; then
  missing_prerequisite "Harbor is not installed (run: uv tool install harbor==${REQUIRED_HARBOR_VERSION})"
fi

# The task packages depend on Harbor v0.5.0 semantics (allow_internet). A
# version mismatch is always a hard failure — never a skip — because running
# under a different version could silently drop the isolation guarantees.
HARBOR_VERSION="$(harbor --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ "$HARBOR_VERSION" != "$REQUIRED_HARBOR_VERSION" ]; then
  echo "FAIL: Harbor ${HARBOR_VERSION:-unknown} found; exactly ${REQUIRED_HARBOR_VERSION} is required"
  exit 1
fi

# The image carries the prebuilt SharedOS checkout (packages/*/dist), staged
# from the host by the Harbor backend — never cloned or built in-container.
# A missing or unbuilt checkout is an environment gap, so it SKIPs like the
# other prerequisites (and FAILs under PACT_HARBOR_SMOKE_REQUIRE=1).
SHAREDOS_PIN="846cbf64830d1a77bf477b98fd3586cd5cdff02e"
SHAREDOS_DIR="${PACT_SHAREDOS_DIR:-$ROOT/../sharedos-repo}"
for package in contracts core os runtime testkit; do
  if [ ! -f "$SHAREDOS_DIR/packages/$package/dist/index.js" ]; then
    missing_prerequisite "SharedOS build not found at $SHAREDOS_DIR (missing packages/$package/dist). Clone Aicoo-Team/SharedOS at $SHAREDOS_PIN, run 'pnpm install --frozen-lockfile && pnpm build', or set PACT_SHAREDOS_DIR"
  fi
done

if [ ! -d node_modules ]; then
  npm ci --silent
fi

RUN_DIRECTORY=""
EGRESS_DIR=""
EGRESS_JOBS=""
cleanup() {
  [ -n "$RUN_DIRECTORY" ] && rm -rf "$RUN_DIRECTORY"
  [ -n "$EGRESS_DIR" ] && rm -rf "$EGRESS_DIR"
  [ -n "$EGRESS_JOBS" ] && rm -rf "$EGRESS_JOBS"
}
trap cleanup EXIT

echo "[1/4] build the Node image and run six PACT-Pair trials through Harbor"
OUTPUT="$(npm run --silent benchmark -- --config examples/pact-run.harbor-smoke.yaml)"
RUN_DIRECTORY="$(printf '%s' "$OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["outputDirectory"])')"

echo "[2/4] verify the image carries the pinned SharedOS build (no in-container clone/build)"
IMAGE_COMMIT="$(docker run --rm --network none pact-bench-harbor:p0 node -p \
  "JSON.parse(require('fs').readFileSync('/opt/pact/sharedos/sharedos-provenance.json','utf8')).commit")"
if [ "$IMAGE_COMMIT" != "$SHAREDOS_PIN" ]; then
  echo "FAIL: image SharedOS provenance is ${IMAGE_COMMIT:-missing}; expected $SHAREDOS_PIN"
  exit 1
fi
docker run --rm --network none pact-bench-harbor:p0 node -e '
const { existsSync } = require("fs");
const dir = process.env.PACT_SHAREDOS_DIR;
if (dir !== "/opt/pact/sharedos") throw new Error("PACT_SHAREDOS_DIR is " + dir);
for (const name of ["contracts", "core", "os", "runtime", "testkit"]) {
  const entry = `${dir}/packages/${name}/dist/index.js`;
  if (!existsSync(entry)) throw new Error(`missing ${entry}`);
}
' || { echo "FAIL: staged SharedOS build is incomplete inside the image"; exit 1; }

echo "[3/4] compare canonical artifacts with normalized local golden"
python3 - "$RUN_DIRECTORY" "$ROOT/tests/golden/pact-pair-smoke-v1" <<'PY'
import json
import pathlib
import sys

actual_dir = pathlib.Path(sys.argv[1])
golden_dir = pathlib.Path(sys.argv[2])

actual_summary = json.loads((actual_dir / "summary.json").read_text())
golden_summary = json.loads((golden_dir / "summary.json").read_text())
assert actual_summary == golden_summary, "Harbor summary differs from local golden"

def load_results(path):
    results = [json.loads(line) for line in path.read_text().splitlines() if line]
    for result in results:
        result["budgetUsed"]["runtimeMs"] = 0
    return results

actual_results = load_results(actual_dir / "results.jsonl")
golden_results = load_results(golden_dir / "results.jsonl")
assert actual_results == golden_results, "Harbor results differ from local golden"

run_metadata = json.loads((actual_dir / "run.json").read_text())
execution = run_metadata.get("execution")
assert execution is not None, "run.json is missing execution provenance"
assert execution.get("backend") == "harbor", "run.json must record the harbor backend"
assert execution.get("executor") == "scripted-harness", (
    "run.json must record the scripted harness as the effective executor"
)
harbor_meta = execution.get("harbor") or {}
assert harbor_meta.get("version") == "0.5.0", "run.json must pin the Harbor version"
assert str(harbor_meta.get("imageId", "")).startswith("sha256:"), (
    "run.json must record the immutable image identity"
)
# Private-artifact contract: traces live under private/, never at the root.
assert (actual_dir / "private" / "trace.jsonl").stat().st_size > 0
assert (actual_dir / "private" / "evaluation.jsonl").stat().st_size > 0
assert not (actual_dir / "trace.jsonl").exists()
assert not (actual_dir / "evaluation.jsonl").exists()
PY

echo "[4/4] denied-egress probe: a Harbor-run container must not reach the network"
EGRESS_DIR="$(mktemp -d)"
EGRESS_JOBS="$(mktemp -d)"
TASK_DIR="$EGRESS_DIR/pact-egress-probe"
mkdir -p "$TASK_DIR/solution" "$TASK_DIR/tests" "$TASK_DIR/environment"

cat > "$TASK_DIR/task.toml" <<TOML
schema_version = "1.3"

[task]
name = "pact/egress-probe"
description = "Assert that PACT Harbor containers cannot reach the network."
authors = [{ name = "PACT-Bench maintainers" }]
keywords = ["privacy", "network-isolation"]

[agent]
timeout_sec = 120.0
user = "root"

[verifier]
timeout_sec = 60.0
user = "root"

[environment]
docker_image = "pact-bench-harbor:p0"
allow_internet = false
build_timeout_sec = 600.0
cpus = 1
memory_mb = 1024
storage_mb = 2048
TOML

cat > "$TASK_DIR/instruction.md" <<'MD'
Attempt outbound network egress and record whether it was blocked.
MD

cat > "$TASK_DIR/environment/Dockerfile" <<'DOCKER'
FROM pact-bench-harbor:p0
DOCKER

cat > "$TASK_DIR/solution/solve.sh" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
mkdir -p /app/pact-output
if node -e "fetch('https://example.com/', { signal: AbortSignal.timeout(10000) }).then(() => process.exit(0), () => process.exit(1))"; then
  echo reached > /app/pact-output/egress.txt
else
  echo blocked > /app/pact-output/egress.txt
fi
SH

cat > "$TASK_DIR/tests/test.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /logs/verifier
if [ "$(cat /app/pact-output/egress.txt)" = "blocked" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
SH
chmod +x "$TASK_DIR/solution/solve.sh" "$TASK_DIR/tests/test.sh"

harbor run \
  --path "$EGRESS_DIR" \
  --agent oracle \
  --jobs-dir "$EGRESS_JOBS" \
  --job-name pact-egress-probe \
  --n-concurrent 1 \
  --max-retries 0 \
  --yes \
  --quiet

REWARD_FILE="$(find "$EGRESS_JOBS" -name reward.txt | head -n 1)"
if [ -z "$REWARD_FILE" ]; then
  echo "FAIL: the egress probe produced no verifier reward"
  exit 1
fi
if [ "$(tr -d '[:space:]' < "$REWARD_FILE")" != "1" ]; then
  echo "FAIL: Harbor container reached the network (egress was not denied)"
  exit 1
fi

echo "HARBOR OK — six Docker trials match the normalized local golden and container egress is denied."
