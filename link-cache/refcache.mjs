#!/usr/bin/env node
// The deprecated `refcache` alias bin: warn, then delegate to link-cache. A
// dedicated wrapper (not an argv[1] sniff) so the notice also fires under
// npm's Windows shims, which invoke the target file directly.

import { main } from './index.mjs';

process.stderr.write(
  '[warn] the refcache bin is deprecated; use link-cache instead.\n',
);
main(process.argv.slice(2));
