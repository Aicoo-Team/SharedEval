import type { PilotMode } from './profile.js';

const USAGE = 'Usage: tsx scripts/pact-net-pilot.ts --output DIR [--mode success|safe-partial] [--max-turns N]';
export function parsePilotArgs(args: readonly string[]): { directory: string; mode: PilotMode; turns: number } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!['--output', '--mode', '--max-turns'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error(USAGE);
    values.set(key, value);
  }
  const directory = values.get('--output');
  const mode = values.get('--mode') ?? 'success';
  const rawTurns = values.get('--max-turns') ?? '20';
  if (!directory || !['success', 'safe-partial'].includes(mode) || !/^(?:0|[1-9][0-9]{0,2})$/.test(rawTurns) || Number(rawTurns) > 100) throw new Error(USAGE);
  return { directory, mode: mode as PilotMode, turns: Number(rawTurns) };
}
