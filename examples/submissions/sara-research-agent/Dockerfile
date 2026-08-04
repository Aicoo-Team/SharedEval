FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
COPY examples/submissions/typescript-basic ./examples/submissions/typescript-basic

USER node

CMD ["./node_modules/.bin/tsx", "examples/submissions/typescript-basic/src/main.ts"]
