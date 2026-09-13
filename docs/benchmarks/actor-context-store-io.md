# Actor Context Store: Verified-Byte Cache Benchmark

## Scope

This is a local, synthetic filesystem benchmark, not a model run or a replay of
private experiment evidence. It measures actual `FileHandle.read` calls and
returned bytes, record opens, record JSON parsing, and elapsed wall time. The
instrumentation delegates to the real filesystem; it does not substitute data.

The change reduces repeated parsing and canonical hashing. It does **not** reduce
historical read calls or bytes, fix their linear growth, or establish that an
end-to-end executor deadline problem is solved.

## Reproduction

Use Node v24.18.0 and the repository dependencies. Run this command serially, with
an unused output path; the benchmark refuses to overwrite an artifact:

```sh
pnpm exec tsx tests/runner-v1/actor-context-store-io.bench.ts --output docs/benchmarks/new-measurement.json
pnpm exec tsx --test tests/runner-v1/actor-context-store.test.ts
```

Each point starts a fresh two-actor store and populates one actor with 0, 8, or 24
completed synthetic turns. Each turn has four approximately 6.5 KB file results,
one contact request/reply, a MEMORY replacement result, and a final reply. It has
13 message records plus begin/finish records. Tool IDs deliberately recur across
turns. The other actor remains empty. All messages and tool results are retained.

Each point measures five `getFrontier` calls, then one begin, 13 separate appends,
and one finish. The append samples have successively growing histories; their
median is not a repeated measurement at a fixed frontier. Setup and final cleanup
are outside measurement. Temporary files are removed after each point.

## Preserved Artifacts

- `actor-context-io-baseline.json`: measured before production edits; store source
  SHA256 `c9ce320d245f8986cf861a082dfdfa0904d876c89ff38c296fe0730a03418de6`
  at the repair worktree's `63bb010` baseline.
- `actor-context-io-verified-byte-cache.json`: initial optimized measurement.
  The focused test process overlapped this measurement, so write timings are
  retained for transparency but should not be used to estimate speedup.
- `actor-context-io-verified-byte-cache-repeat.json`: optimized repeat without
  this agent running tests concurrently. Other host activity is not controlled.
  Both optimized artifacts have store source SHA256
  `abc18a67311165dca29943391c6e3b38d7cb40f7ce7a04f757ea39cd8459df11`.

The artifacts include all raw measurement counters, projected prior-history hash,
next input hash, and final durable frontier. Comparison of both optimized artifacts
against baseline verified exact equality of every operation's read-call, returned
byte, and record-open counters, and every history/input/frontier hash.

## Results

For one `getFrontier`, actual reads and bytes are identical before and after:

| Prior turns | Records | Read calls | Returned bytes | Record JSON parses, before / after | Median ms, before / repeat |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | 4 | 302 | 0 / 0 | 0.535 / 0.493 |
| 8 | 120 | 244 | 263324 | 120 / 0 | 14.841 / 7.279 |
| 24 | 360 | 724 | 790016 | 360 / 0 | 42.215 / 17.113 |

The counters include manifest and frontier reads, and the existing EOF read per
file. Returned bytes are application-visible bytes, not physical disk traffic;
the operating system may serve them from its page cache. Read timing is therefore
not a cold-disk benchmark. The 24-turn read-only check was about 59% faster in this
repeat, but this is an indicative local wall-time observation, not a stable SLA.

At 24 turns, baseline versus repeat timings were 48.540 / 39.182 ms for begin,
43.078 / 35.901 ms for the append median, and 45.913 / 36.099 ms for finish. These
include durable writes and fsync, so they are especially sensitive to host load.
No timing threshold is used as a correctness test.

## Integrity and Equivalence

- Every hot check still opens and rereads every record, including the extra EOF
  read. Existing descriptor/path identity, symlink, size, mtime, directory, lock,
  manifest, chain-link, and durable-frontier checks remain in place.
- A cache hit requires SHA256 of freshly read complete bytes to match previously
  verified bytes. Size or timestamps alone never authorize a cache hit. This uses
  the same cryptographic collision-resistance assumption as the existing chain.
- The cache stores only wire digest and actor/sequence/previous-hash/record-hash
  pointers, not a second copy of message bodies. Its memory still grows linearly
  with record count. No journal bytes, history, roles, replies, or call IDs change.
- Changed serialization falls back to full UTF-8 decode, JSON and schema parsing,
  and canonical record-hash verification. Semantically identical formatting is
  accepted as before, and its digest is reused only after the complete chain and
  durable frontier pass. Changed content is not trusted because a file existed in
  the cache.
- Newly published record metadata is cached only after record and frontier are
  durable. Reopening starts without a cache and performs full semantic replay,
  including turn sequencing, tool linkage, and input-history hashes.
- The two new regression tests first failed on the baseline's repeated parse
  counts (5 rather than 0, and 3 rather than 1). After implementation, all 23
  focused store tests passed, including preserved-mtime/same-size tampering,
  externally rehashed invalid histories, unfinished turns, missing/torn records,
  actor isolation, and hot/cold projection equivalence.

Under the current external-tampering threat model, skipping unchanged-looking
files would weaken the checks. Removing the linear I/O cost needs a separately
specified trusted storage or immutability boundary; this patch does not introduce
one. No production store adapter, permission policy, or journal format changed.
