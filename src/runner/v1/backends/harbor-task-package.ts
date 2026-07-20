import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { PactRunConfigV1 } from '../config.js';
import type { LoadedPactPairTaskV1 } from '../task-loader.js';

export type MaterializeHarborDatasetV1Options = {
  datasetDirectory: string;
  templateDirectory: string;
  imageName: string;
  config: PactRunConfigV1;
  tasks: LoadedPactPairTaskV1[];
};

export async function materializeHarborDatasetV1(
  options: MaterializeHarborDatasetV1Options,
): Promise<void> {
  await mkdir(options.datasetDirectory, { recursive: true });
  await Promise.all(options.tasks.map(async task => {
    const taskDirectory = join(
      options.datasetDirectory,
      task.taskId.toLocaleLowerCase('en-US'),
    );
    await copyTemplateDirectory(options.templateDirectory, taskDirectory);
    const taskImageName = harborTaskImageName(options.imageName, task.taskId);
    const replacements: Record<string, string> = {
      TASK_ID: task.taskId,
      TASK_SLUG: task.taskId.toLocaleLowerCase('en-US'),
      IMAGE_NAME: taskImageName,
      POLICY: options.config.benchmark.policy,
      REQUESTER: options.config.benchmark.requester,
      MAX_TURNS: String(options.config.budget.maxTurns),
      MAX_TOOL_CALLS: String(options.config.budget.maxToolCalls),
      MAX_RUNTIME_MS: String(options.config.budget.maxRuntimeMs),
      AGENT_TIMEOUT_SEC: String(
        Math.ceil(options.config.budget.maxRuntimeMs / 1_000) + 30,
      ),
    };
    await replaceTokensRecursively(taskDirectory, replacements);
  }));
}

export function harborTaskImageName(baseImageName: string, taskId: string): string {
  return `${baseImageName}-${taskId.toLocaleLowerCase('en-US')}`;
}

async function copyTemplateDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTemplateDirectory(sourcePath, targetPath);
      return;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported Harbor template entry: ${sourcePath}`);
    }
    await copyFile(sourcePath, targetPath);
  }));
}

async function replaceTokensRecursively(
  directory: string,
  replacements: Record<string, string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await replaceTokensRecursively(entryPath, replacements);
      return;
    }
    if (!entry.isFile()) return;
    let source = await readFile(entryPath, 'utf8');
    for (const [name, value] of Object.entries(replacements)) {
      source = source.split(`{{${name}}}`).join(value);
    }
    if (/\{\{[A-Z_]+\}\}/.test(source)) {
      throw new Error(`Unresolved token in Harbor task template ${entryPath}`);
    }
    await writeFile(entryPath, source, 'utf8');
  }));
}
