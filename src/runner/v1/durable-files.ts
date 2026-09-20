import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function syncDirectoryV1(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (
      code === 'EINVAL'
      || code === 'ENOTSUP'
      || (process.platform === 'win32' && code === 'EPERM')
    ) {
      return;
    }
    throw error;
  } finally {
    await handle.close();
  }
}
