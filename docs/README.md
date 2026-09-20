# User docs

For sites that run `lychee-norm-cache` and `link-cache` around a committed
`link-cache.jsonc`. Start with the first page; the rest are in the order a site
meets them.

- [Install and run](cli.md): the bins, their options, and the `npx` fallback to
  avoid.
- [Operating model](operating-model.md): how the cache is used at run time, and
  the two CI lanes a site needs, PR checks and a scheduled refresh.
- [The owned cache: `link-cache.jsonc`](cache-format.md): the file's shape,
  keys, and fields, and what a hand edit may touch.
- [Migrating to lychee and link-cache](migrate.md): from htmltest with a
  `refcache.json`, and from a committed `.lycheecache`.

Maintainer docs are under [`_docs/`](../_docs/README.md).
