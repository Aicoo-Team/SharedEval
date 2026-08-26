import {
  runOneFileDrivenPairSessionV1,
  type FileDrivenPairSessionV1,
  type RunOneFileDrivenPairSessionV1Options,
} from './file-workflow.js';

export type RunPactPairFilesMultiV1Options = Omit<
  RunOneFileDrivenPairSessionV1Options,
  'workflowId' | 'sessionIndex'
>;

/** Multi is only a policy selection over the one shared session scheduler. */
export function runPactPairFilesMultiV1(
  options: RunPactPairFilesMultiV1Options,
): Promise<FileDrivenPairSessionV1> {
  return runOneFileDrivenPairSessionV1({
    ...options,
    workflowId: 'files-multi',
    sessionIndex: 0,
  });
}
