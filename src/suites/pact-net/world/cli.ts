const USAGE = 'Usage: tsx scripts/pact-net-world.ts --profile JSON --output DIR [--max-turns N]';

/** One invocation may stop at any committed turn; reuse the same output to resume. */
export function parseWorldArgs(args: readonly string[]): { directory: string; profilePath: string; turns: number } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!['--profile', '--output', '--max-turns'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error(USAGE);
    values.set(key, value);
  }
  const directory = values.get('--output');
  const profilePath = values.get('--profile');
  const rawTurns = values.get('--max-turns') ?? '40';
  if (!directory || !profilePath || !/^(?:0|[1-9][0-9]{0,3})$/.test(rawTurns) || Number(rawTurns) > 1000) throw new Error(USAGE);
  return { directory, profilePath, turns: Number(rawTurns) };
}
