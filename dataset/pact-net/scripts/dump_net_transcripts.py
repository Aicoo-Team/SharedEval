#!/usr/bin/env python3
"""Dump every message of every PACT-Net run, with the matrix label beside it.

One block per (run, task): what the requester sent, what the responder replied,
the matrix's L/P label for that requester and category, the stated decision, and
whether a gold fact was in the body. Reading a J number without reading these is
how the last two headline results turned out to be artefacts.
"""
import argparse, json, textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MATRIX = ROOT / 'dataset/pact-net/world_design/relational_access_matrix.json'
QUESTIONS = ROOT / 'dataset/pact-pair/tasks/questions.json'
SEATS = {'R5': 'sarah_martinez', 'R6': 'carlos_reyes', 'R7': 'elena_park',
         'R8': 'tina_rodriguez', 'R9': 'jordan_park'}


def wrap(text, indent='    ', width=96):
    out = []
    for para in (text or '').split('\n'):
        out.extend(textwrap.wrap(para, width, initial_indent=indent,
                                 subsequent_indent=indent) or [indent.rstrip()])
    return '\n'.join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--owner', default='alex_chen')
    ap.add_argument('--max-body', type=int, default=1400,
                    help='characters of each reply to print; 0 for the whole body')
    a = ap.parse_args()

    matrix = json.loads(MATRIX.read_text())
    truth = matrix['agents'][a.owner]['requesters']
    cats = {f"PAIR-Q{q['id']}": q['category']
            for q in json.loads(QUESTIONS.read_text())['questions']}
    texts = {f"PAIR-Q{q['id']}": q['question']
             for q in json.loads(QUESTIONS.read_text())['questions']}

    for m in json.loads(Path(a.manifest).read_text()):
        run = Path(a.runs) / m['name'] / m['runId'] / 'multi'
        who = SEATS[m['requester']]
        print('=' * 100)
        print(f"RUN {m['name']}   policy={m['policy']}   requester={m['requester']} "
              f"({who})")
        if not run.exists():
            print('  (no artefacts -- run did not produce a world)')
            continue

        sent = {}
        msg_dir = run / '.sharedeval-sharedos-session/messages'
        for f in sorted(msg_dir.glob('record-*.json')) if msg_dir.exists() else []:
            env = json.loads(f.read_text())['envelope']
            if env['sender']['agentId'] != 'requester':
                continue
            p = env.get('payload') or {}
            sent.setdefault(p.get('taskId'), []).append(p.get('message'))

        results = {}
        rf = run / 'results.jsonl'
        if rf.exists():
            results = {r['taskId']: r for r in
                       (json.loads(l) for l in rf.read_text().splitlines() if l.strip())}

        replies = {}
        tf = run / 'ticks.jsonl'
        if tf.exists():
            for t in (json.loads(l) for l in tf.read_text().splitlines() if l.strip()):
                tid = t.get('selectedTaskId')
                if tid and t.get('response'):
                    replies.setdefault(tid, []).append((t['tick'], t['response'],
                                                        t.get('memoryStatus'),
                                                        t.get('memoryNote')))

        for task_id in m['tasks']:
            cat = cats[task_id]
            label = (truth.get(who) or {}).get(cat, '-')
            row = results.get(task_id) or {}
            pe = row.get('publicEvaluation') or {}
            should = {'L': 'ANSWER', 'P': 'REFUSE'}.get(label, f'({label})')
            decided = pe.get('actualDecision') or row.get('status') or 'not reached'
            mark = ''
            if label in ('L', 'P') and pe.get('scorable'):
                ok = (label == 'L') == (decided == 'answer')
                mark = '  <<< as labelled' if ok else '  <<< AGAINST the label'
            print(f"\n  {task_id}  {cat}   matrix={label} -> should {should}"
                  f"   decision={decided}"
                  f"   goldFactInBody={pe.get('leaked')}"
                  f"   scorable={pe.get('scorable')}{mark}")
            print(f"    Q: {texts[task_id]}")
            for i, msg in enumerate(sent.get(task_id, [])):
                print(f'    --- requester ask {i + 1} ---')
                print(wrap(msg))
            for tick, body, mem_status, note in replies.get(task_id, []):
                shown = body if a.max_body == 0 else body[:a.max_body]
                trunc = '' if (a.max_body == 0 or len(body) <= a.max_body) else \
                    f'\n    [... {len(body) - a.max_body} more characters]'
                print(f'    --- responder reply, tick {tick} '
                      f'(MEMORY {mem_status}) ---')
                print(wrap(shown) + trunc)
                if note:
                    print(f'    MEMORY note: {note}')
        print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
