#!/usr/bin/env node
// Aggregate per-task results of a pact-pair grid run into per-persona metrics.
//
// The artifact tree is written by container uid 1000 with 0700 dirs, so on the
// host this is meant to run inside a container with the grid output mounted
// read-only, e.g.:
//
//   docker run --rm -u 0 \
//     -v "$HOME/grid-out-id2:/t:ro" \
//     -v "$HOME/aicoo/pact/scripts/experiments/merge-grid-metrics.mjs:/m.mjs:ro" \
//     node:24 node /m.mjs /t
//
// Shard directories whose slug ends in -rN or -rN<letter> (id2-r0a,
// single-d2rprinciples-r2, ...) are merged into one persona bucket rN.
// Prints a per-persona table plus a JSON blob for downstream comparison.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: merge-grid-metrics.mjs <grid-out-root>...");
  process.exit(2);
}

const personaOf = (slug) => {
  const m = /-r(\d)[a-z]?$/.exec(slug);
  return m ? `r${m[1]}` : null;
};

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// root/<slug>/<runPrefix>.<slug>/runs/<runId>/single/<NNNN-taskId>/
const taskDirsOf = (shardDir) => {
  const out = [];
  for (const cell of readdirSync(shardDir)) {
    const runsDir = join(shardDir, cell, "runs");
    if (!isDir(runsDir)) continue;
    for (const runId of readdirSync(runsDir)) {
      const singleDir = join(runsDir, runId, "single");
      if (!isDir(singleDir)) continue;
      for (const task of readdirSync(singleDir)) {
        const d = join(singleDir, task);
        if (isDir(d)) out.push(d);
      }
    }
  }
  return out;
};

const personas = new Map();
const bucket = (persona) => {
  if (!personas.has(persona)) {
    personas.set(persona, {
      shards: [],
      tasks: 0,
      missingResult: [],
      statuses: {},
      decisions: {},
      errorCodes: {},
      metrics: {},
      duplicateTaskIds: [],
      seenTaskIds: new Set(),
    });
  }
  return personas.get(persona);
};

for (const root of roots) {
  for (const slug of readdirSync(root)) {
    const shardDir = join(root, slug);
    if (!isDir(shardDir)) continue;
    const persona = personaOf(slug);
    if (!persona) {
      console.error(`skipping ${slug}: no -rN suffix`);
      continue;
    }
    const b = bucket(persona);
    b.shards.push(slug);
    for (const taskDir of taskDirsOf(shardDir)) {
      const resultsPath = join(taskDir, "results.jsonl");
      if (!existsSync(resultsPath)) {
        b.missingResult.push(basename(taskDir));
        continue;
      }
      for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        b.tasks += 1;
        if (b.seenTaskIds.has(row.taskId)) b.duplicateTaskIds.push(row.taskId);
        b.seenTaskIds.add(row.taskId);
        b.statuses[row.status] = (b.statuses[row.status] ?? 0) + 1;
        if (row.errorCode)
          b.errorCodes[row.errorCode] = (b.errorCodes[row.errorCode] ?? 0) + 1;
        const decision = row.publicEvaluation?.actualDecision ?? "(none)";
        b.decisions[decision] = (b.decisions[decision] ?? 0) + 1;
      }
      const summaryPath = join(taskDir, "summary.json");
      if (!existsSync(summaryPath)) continue;
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      for (const m of summary.metrics ?? []) {
        const agg = (b.metrics[m.metric] ??= { numerator: 0, denominator: 0 });
        agg.numerator += m.numerator;
        agg.denominator += m.denominator;
      }
    }
  }
}

const pct = (agg) =>
  agg && agg.denominator > 0
    ? `${((100 * agg.numerator) / agg.denominator).toFixed(1)}% (${agg.numerator}/${agg.denominator})`
    : "n/a";

const report = {};
for (const persona of [...personas.keys()].sort()) {
  const b = personas.get(persona);
  report[persona] = {
    shards: b.shards.sort(),
    tasks: b.tasks,
    statuses: b.statuses,
    decisions: b.decisions,
    errorCodes: b.errorCodes,
    duplicateTaskIds: b.duplicateTaskIds,
    missingResult: b.missingResult,
    metrics: Object.fromEntries(
      Object.entries(b.metrics).map(([k, v]) => [
        k,
        { ...v, value: v.denominator > 0 ? v.numerator / v.denominator : null },
      ]),
    ),
  };

  console.log(`\n=== ${persona} (${b.shards.sort().join(", ")}) — ${b.tasks} tasks ===`);
  console.log(`  statuses: ${JSON.stringify(b.statuses)}`);
  console.log(`  decisions: ${JSON.stringify(b.decisions)}`);
  if (Object.keys(b.errorCodes).length)
    console.log(`  errorCodes: ${JSON.stringify(b.errorCodes)}`);
  if (b.duplicateTaskIds.length)
    console.log(`  DUPLICATE taskIds: ${b.duplicateTaskIds.join(", ")}`);
  if (b.missingResult.length)
    console.log(`  MISSING results.jsonl: ${b.missingResult.length} tasks`);
  for (const key of [
    "informationUtility",
    "informationSecurity",
    "falseRefusalRate",
    "leakRate",
    "policyComplianceInformationUtility",
    "policyComplianceInformationSecurity",
    "policyComplianceFalseRefusalRate",
    "policyComplianceLeakRate",
  ])
    console.log(`  ${key.padEnd(38)} ${pct(b.metrics[key])}`);
}

console.log(`\n<json>${JSON.stringify(report)}</json>`);
