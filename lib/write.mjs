// Atomic file write shared by the bins: write to a same-directory temp file,
// then rename over the target. A crash mid-write leaves the original intact
// instead of a truncated cache (which the strict parsers would then reject,
// wedging every subsequent run).

import { renameSync, writeFileSync } from 'node:fs';

export function writeFileAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
