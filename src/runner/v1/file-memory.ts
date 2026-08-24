import { Buffer } from 'node:buffer';

export const FILE_MEMORY_STATUSES_V1 = [
  'pending',
  'answered',
  'refused',
  'error',
] as const;
export type FileMemoryStatusV1 = (typeof FILE_MEMORY_STATUSES_V1)[number];

/** A note is bounded in encoded bytes, not UTF-16 code units. */
export const MAX_FILE_MEMORY_NOTE_BYTES_V1 = 4096;

export type FileMemoryRowV1 = {
  taskId: string;
  status: FileMemoryStatusV1;
  note: string;
};

const statuses = new Set<string>(FILE_MEMORY_STATUSES_V1);
const canonicalRow = /^(.*?) \[([a-z]+)\] — (.*)$/;

/**
 * Parses the sole mutable runtime file.  A complete replacement must retain
 * the trusted selected task set byte-for-byte in its original order.
 */
export function parseFileMemoryV1(input: {
  content: string;
  selectedTaskIds: readonly string[];
}): FileMemoryRowV1[] {
  assertStrictUtf8(input.content, 'MEMORY content');
  assertSelectedTaskIds(input.selectedTaskIds);

  const lines = input.content.endsWith('\n')
    ? input.content.slice(0, -1).split('\n')
    : input.content.split('\n');
  if (lines.length !== input.selectedTaskIds.length) {
    throw new Error('MEMORY must contain exactly one canonical row per selected task');
  }

  return lines.map((line, index) => {
    const match = canonicalRow.exec(line);
    if (!match) {
      throw new Error(`MEMORY row ${index + 1} must use TASK-ID [status] — note`);
    }
    const [, taskId, status, note] = match;
    if (taskId !== input.selectedTaskIds[index]) {
      throw new Error(
        `MEMORY row ${index + 1} must preserve selected task ${JSON.stringify(input.selectedTaskIds[index])} in order`,
      );
    }
    if (!statuses.has(status)) {
      throw new Error(`MEMORY row ${index + 1} has an unsupported status`);
    }
    assertStrictUtf8(note, `MEMORY row ${index + 1} note`);
    if (Buffer.byteLength(note, 'utf8') > MAX_FILE_MEMORY_NOTE_BYTES_V1) {
      throw new Error(
        `MEMORY row ${index + 1} note exceeds ${MAX_FILE_MEMORY_NOTE_BYTES_V1} UTF-8 bytes`,
      );
    }
    return { taskId, status: status as FileMemoryStatusV1, note };
  });
}

export function assertFileMemoryV1(input: {
  content: string;
  selectedTaskIds: readonly string[];
}): void {
  parseFileMemoryV1(input);
}

function assertSelectedTaskIds(taskIds: readonly string[]): void {
  if (taskIds.length === 0) {
    throw new Error('MEMORY requires at least one selected task');
  }
  const seen = new Set<string>();
  for (const taskId of taskIds) {
    if (
      typeof taskId !== 'string'
      || taskId.length === 0
      || taskId.includes('\n')
      || taskId.includes('\r')
      || taskId.includes(' [')
      || seen.has(taskId)
    ) {
      throw new Error('selected task IDs must be unique canonical task identifiers');
    }
    assertStrictUtf8(taskId, 'selected task ID');
    seen.add(taskId);
  }
}

function assertStrictUtf8(value: string, label: string): void {
  const bytes = Buffer.from(value, 'utf8');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (decoded !== value) {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

