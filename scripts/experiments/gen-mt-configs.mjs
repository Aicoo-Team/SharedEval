#!/usr/bin/env node
// Generate the multi-turn probe cell configs: one sharedeval-run/v1 YAML per
// 60-task split, mode multi + workflow.multiTurn, for run-cell.sh / mt-lane.sh.
//
// Usage:
//   gen-mt-configs.mjs --out <dir> \
//     [--policy D2] [--requester R1] \
//     [--model deepseek/deepseek-v4-flash-0731] [--provider-only Inceptron] \
//     [--max-ticks 240] [--phase2 61] [--finalize 230] \
//     [--splits-dir dataset/pact-pair/splits/10_splits_v2]
//
// QA ids map to PAIR-Q<id> (notes 1-200, todos 201-400) and action ids to
// PAIR-A<id>, exactly as src/suites/pact-pair/task-loader.ts derives them.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined) {
    console.error(`--${name} requires a value`);
    process.exit(2);
  }
  return value;
};

const outDir = option("out");
if (!outDir) {
  console.error("usage: gen-mt-configs.mjs --out <dir> [options]");
  process.exit(2);
}
const policy = option("policy", "D2");
const requester = option("requester", "R1");
const model = option("model", "deepseek/deepseek-v4-flash-0731");
const providerOnly = option("provider-only", "Inceptron");
const maxTicks = Number(option("max-ticks", "240"));
const phase2 = Number(option("phase2", "61"));
const finalize = Number(option("finalize", "230"));
const splitsDir = resolve(repoRoot, option("splits-dir", "dataset/pact-pair/splits/10_splits_v2"));

const splitFiles = readdirSync(splitsDir)
  .filter((name) => /^split_\d+\.json$/.test(name))
  .sort();
if (splitFiles.length === 0) {
  console.error(`no split_NN.json files under ${splitsDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const allIds = new Set();
for (const file of splitFiles) {
  const split = JSON.parse(readFileSync(join(splitsDir, file), "utf8"));
  const ids = [
    ...split.notes_qa.ids.map((id) => `PAIR-Q${id}`),
    ...split.todo_qa.ids.map((id) => `PAIR-Q${id}`),
    ...split.actions.ids.map((id) => `PAIR-A${id}`),
  ];
  if (ids.length !== split.total) {
    console.error(`${file}: ${ids.length} ids but total ${split.total}`);
    process.exit(1);
  }
  for (const id of ids) {
    if (allIds.has(id)) {
      console.error(`${file}: ${id} already assigned to an earlier split`);
      process.exit(1);
    }
    allIds.add(id);
  }
  const yaml = `apiVersion: sharedeval-run/v1
kind: RunConfig
model:
  provider: openai-compatible
  baseUrl: https://openrouter.ai/api/v1
  apiKeyEnv: SHAREDEVAL_MODEL_API_KEY
  model: ${model}
  temperature: 0
  providerRouting:
    requireParameters: true
    allowFallbacks: false
    only: [${providerOnly}]
  maxOutputTokens: 4096
benchmark:
  dataset: pact-pair
  policy: ${policy}
  requester: ${requester}
  gradingMode: category
  tasks:
    kind: all
    ids: [${ids.join(", ")}]
workflow:
  mode: multi
  protocol: files
  maxTicks: ${maxTicks}
  stopWhen: all-terminal
  multiTurn:
    phase2StartTick: ${phase2}
    finalizeTick: ${finalize}
budget:
  maxToolCalls: 12
  maxRuntimeMs: 300000
`;
  const outName = file.replace(/\.json$/, ".yaml");
  writeFileSync(join(outDir, outName), yaml);
  console.log(`${outName}: ${ids.length} tasks`);
}
console.log(`total unique tasks: ${allIds.size}`);
