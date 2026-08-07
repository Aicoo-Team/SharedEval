FROM node:22-bookworm-slim AS build

WORKDIR /opt/pact
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.harbor.json ./
COPY src ./src
RUN npm run build:harbor \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
COPY --from=build /opt/pact/package.json /opt/pact/package.json
COPY --from=build /opt/pact/node_modules /opt/pact/node_modules
COPY --from=build /opt/pact/dist /opt/pact/dist
COPY dataset /opt/pact/dist/dataset

# Prebuilt SharedOS packages/*/dist, staged into the build context by the
# Harbor backend (stageSharedOsBuildV1) from a checkout pinned to commit
# 846cbf64830d1a77bf477b98fd3586cd5cdff02e — see sharedos-provenance.json
# inside the staged tree. The image only ever COPYs these build artifacts;
# cloning or building SharedOS in-container is forbidden (no-network
# principle). PACT_SHAREDOS_DIR points the embedded adapter's loader
# (src/execution/sharedos/v1/load-sharedos.ts) at the staged checkout.
COPY harbor/environment/sharedos-stage /opt/pact/sharedos
ENV PACT_SHAREDOS_DIR=/opt/pact/sharedos

RUN mkdir -p /app/pact-output \
    && chmod 0777 /app/pact-output

ENV NODE_ENV=production
CMD ["/bin/bash"]
