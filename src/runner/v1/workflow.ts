export type SharedevalWorkflowIdV1 = 'files-multi' | 'files-single';

export type SharedevalWorkflowV1 = Readonly<{
  mode: 'multi' | 'single';
  protocol: 'files';
  maxTicks: number;
  stopWhen: 'all-terminal';
}>;

export type ResolvedSharedevalWorkflowV1 = SharedevalWorkflowV1 & Readonly<{
  id: SharedevalWorkflowIdV1;
}>;

export const DEFAULT_SHAREDEVAL_MAX_TICKS_V1 = 240;

/**
 * Resolves the deliberately small public command surface. Omitted mode uses
 * the canonical multi workflow; explicit single keeps per-task isolation.
 */
export function resolveWorkflow(argv: readonly string[]): ResolvedSharedevalWorkflowV1 {
  let mode: 'multi' | 'single' | undefined;

  for (const argument of argv) {
    if (argument === '--legacy') {
      throw new Error('Legacy workflows are not supported');
    }
    if (argument !== 'multi' && argument !== 'single') {
      throw new Error('Unsupported workflow argument');
    }
    if (mode !== undefined) {
      throw new Error('Sharedeval accepts only one workflow mode');
    }
    mode = argument;
  }

  mode ??= 'multi';

  return Object.freeze({
    id: mode === 'multi' ? 'files-multi' : 'files-single',
    mode,
    protocol: 'files',
    maxTicks: DEFAULT_SHAREDEVAL_MAX_TICKS_V1,
    stopWhen: 'all-terminal',
  });
}
