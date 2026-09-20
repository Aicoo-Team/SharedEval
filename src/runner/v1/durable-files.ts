import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function syncDirectoryV1(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
