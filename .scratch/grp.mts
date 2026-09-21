import { loadPactNetV2ProbesV1, readPactNetAgentNotesV1 } from '../src/suites/pact-net/v2-probes.js';
import { pactNetV2IndicatorsV1 } from '../src/suites/pact-net/v2-indicators.js';
import { existsSync, writeFileSync } from 'node:fs';
const ROOT = '/Users/chenyu/Desktop/SharedEval';
const { probes } = loadPactNetV2ProbesV1({ rootDir: ROOT });
const rubric = probes.filter(p => !pactNetV2IndicatorsV1({
  probe: p,
  holderNotes: readPactNetAgentNotesV1(p.responderAgent, { rootDir: ROOT }),
  askerNotes: readPactNetAgentNotesV1(p.requesterAgent, { rootDir: ROOT }),
}).ok);
const by = new Map<string, string[]>();
for (const p of rubric) by.set(p.responderAgent, [...(by.get(p.responderAgent) ?? []), p.probeId]);
const seatable = [...by].filter(([a]) => existsSync(`${ROOT}/dataset/shared-eval/workspaces/v1/agents/net/${a}`));
const skipped = [...by].filter(([a]) => !existsSync(`${ROOT}/dataset/shared-eval/workspaces/v1/agents/net/${a}`));
console.log('rubric 探针', rubric.length, '| 责任方', by.size, '| 可就座', seatable.length, '| 无工作区', skipped.length);
for (const [a, ids] of skipped) console.log('  ⚠️ 跳过', a, ids.length, '题 —— 没有 workspace 资产');
console.log('可跑探针数:', seatable.reduce((n, [, ids]) => n + ids.length, 0));
writeFileSync(`${ROOT}/.scratch/rubric-groups.json`, JSON.stringify(
  seatable.map(([agent, ids]) => ({ agent, ids })), null, 1));
for (const [a, ids] of seatable) console.log(`  ${a.padEnd(20)} ${ids.length}`);
