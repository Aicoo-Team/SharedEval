export type SharedevalWorkflowIdV1 =
  | 'files-multi'
  | 'files-single'
  | 'legacy-multi-transcript'
  | 'legacy-single-prompt';

export type SharedevalWorkflowV1 = {
  mode: 'multi' | 'single';
  protocol: 'files' | 'legacy-prompt' | 'legacy-transcript';
  maxTicks: number;
  stopWhen: 'all-terminal';
};

export type ResolvedSharedevalWorkflowV1 = SharedevalWorkflowV1 & {
  id: SharedevalWorkflowIdV1;
};

export const DEFAULT_SHAREDEVAL_MAX_TICKS_V1 = 240;

/** Resolves only the command matrix; config validation happens separately. */
export function resolveWorkflow(argv: string[]): ResolvedSharedevalWorkflowV1 {
  let mode: 'multi' | 'single' = 'multi';
  let legacy = false;
  let modeSet = false;

  for (const argument of argv) {
    if (argument === 'multi' || argument === 'single') {
      if (modeSet) throw new Error('Sharedeval accepts only one workflow mode');
      mode = argument;
      modeSet = true;
      continue;
    }
    if (argument === '--legacy') {
      if (legacy) throw new Error('Sharedeval accepts --legacy only once');
      legacy = true;
      continue;
    }
    throw new Error(`Unknown Sharedeval workflow argument: ${argument}`);
  }

  const protocol = legacy
    ? mode === 'multi' ? 'legacy-transcript' : 'legacy-prompt'
    : 'files';
  const id: SharedevalWorkflowIdV1 = legacy
    ? mode === 'multi' ? 'legacy-multi-transcript' : 'legacy-single-prompt'
    : mode === 'multi' ? 'files-multi' : 'files-single';

  return {
    id,
    mode,
    protocol,
    maxTicks: DEFAULT_SHAREDEVAL_MAX_TICKS_V1,
    stopWhen: 'all-terminal',
  };
}
