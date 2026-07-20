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
COPY pact_pair /opt/pact/dist/pact_pair

RUN mkdir -p /app/pact-output \
    && chmod 0777 /app/pact-output

ENV NODE_ENV=production
CMD ["/bin/bash"]
