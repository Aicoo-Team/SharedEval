/** Thin CLI for the safe, read-only public run overview. */
import { runWatchRunsCliV1 } from '../src/runner/v1/watch-runs.js';

process.exitCode = await runWatchRunsCliV1(process.argv.slice(2));
