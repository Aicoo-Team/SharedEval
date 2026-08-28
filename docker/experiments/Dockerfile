# syntax=docker/dockerfile:1
# Experiment runner image for run-level cells (one container per cell/run).
#
# The build context is assembled by scripts/experiments/build-image.sh and
# NEVER points at a working tree:
#   sharedeval/  committed SharedEval tree (git archive of HEAD plus pinned,
#                shallow git metadata so the runner's clean-tracked-checkout
#                gate holds inside the image for the true revision)
#   sharedos/    staged SharedOS build at the pinned revision, carrying
#                sharedos-provenance.json (commit + runtime digest) written
#                by scripts/experiments/stage-sharedos-provenance.ts
#
# SHAREDEVAL_MODEL_API_KEY is never baked here; it reaches the container only
# via `docker compose run -e` at cell launch.
FROM node:24-slim

ARG SHAREDEVAL_SOURCE_REVISION=""
ARG SHAREDOS_REVISION=""
ARG SHAREDOS_RUNTIME_DIGEST=""
LABEL org.sharedeval.source-revision="${SHAREDEVAL_SOURCE_REVISION}" \
      org.sharedeval.sharedos-revision="${SHAREDOS_REVISION}" \
      org.sharedeval.sharedos-runtime-digest="${SHAREDOS_RUNTIME_DIGEST}"

# The model client uses globalThis.fetch (undici); NODE_USE_ENV_PROXY=1 makes
# it honor HTTPS_PROXY/NO_PROXY with zero code changes (requires Node >= 24).
# HOME and every cache live on tmpfs /tmp because the rootfs is read-only at
# runtime; the pinned SharedOS build is resolved from /opt/sharedos.
ENV NODE_USE_ENV_PROXY=1 \
    SHAREDEVAL_SHAREDOS_DIR=/opt/sharedos \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/.cache \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_audit=false \
    npm_config_fund=false

# git: the production runner refuses to run outside a clean tracked checkout.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system safe.directory /opt/sharedeval

WORKDIR /opt/sharedeval

# Install strictly from the committed lockfile.
COPY sharedeval/package.json sharedeval/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY sharedeval/ /opt/sharedeval/
COPY sharedos/ /opt/sharedos/

# Fail the build unless the baked tree already satisfies the gates the runner
# enforces at cell start: a clean tracked checkout at a real revision, and a
# provenance-bearing SharedOS runtime staged at the pinned revision.
RUN set -eux; \
  git -C /opt/sharedeval rev-parse --verify HEAD >/dev/null; \
  test -z "$(git -C /opt/sharedeval status --porcelain --untracked-files=no)"; \
  test -s /opt/sharedos/sharedos-provenance.json; \
  grep -q '"commit"' /opt/sharedos/sharedos-provenance.json; \
  grep -q '"runtimeDigest"' /opt/sharedos/sharedos-provenance.json; \
  for package in contracts core os runtime; do \
    test -f "/opt/sharedos/packages/$package/package.json"; \
    test -f "/opt/sharedos/packages/$package/dist/index.js"; \
  done

USER node
CMD ["node", "--version"]
