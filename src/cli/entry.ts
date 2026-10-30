import fs from 'node:fs';

/** npm's bin is a symlink named `telepathy`, with no extension. Compare the real file. */
export function resolveArgvPath(entry: string): string {
  if (!entry) return '';
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
}

export function isCliEntry(entry: string): boolean {
  return /(?:^|[/\\])(?:telepathy|cli)\.(?:mjs|ts|js)$/.test(resolveArgvPath(entry));
}
