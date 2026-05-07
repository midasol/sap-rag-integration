# [Bug] Turbopack CSS @import resolver ignores `turbopack.root` and crashes the host when an empty `package-lock.json` exists in a parent directory

**Status:** draft — file at https://github.com/vercel/next.js/issues when ready.

## Summary

When the parent directory of a Next.js 16 project contains *any* npm/pnpm/yarn
workspace marker — even a meaningless 88-byte empty `package-lock.json` — the
Turbopack CSS `@import` resolver treats that parent directory as the workspace
root, regardless of an explicit `turbopack.root` pin in `next.config.ts`.

Resolution of `@import "tailwindcss"` then fails. Each failure produces a
~30 KB error object. The Turbopack issue collector retains every error
without dedup or rate limiting. Within ~30 seconds of the first request,
the host's memory and `posix_spawn` resources are exhausted; the dev server
hangs and other shells on the host start failing with `EAGAIN`.

## Repro

1. Create a Next 16 project that uses Tailwind v4 (`@import "tailwindcss"`
   in `globals.css`) and the `@tailwindcss/postcss` plugin. Install via
   pnpm so deps live under `node_modules/.pnpm/`.
2. In the project's parent directory, create a stray empty lockfile:
   ```bash
   echo '{"name":"parent","lockfileVersion":3,"requires":true,"packages":{}}' \
     > ../package-lock.json
   ```
3. In `next.config.ts`, explicitly pin Turbopack root to the project (this
   should be sufficient to prevent the bug, but is not):
   ```ts
   const nextConfig: NextConfig = {
     turbopack: { root: process.cwd() },
     outputFileTracingRoot: process.cwd(),
     // ...
   };
   ```
4. Start the dev server and hit any page that imports `globals.css`:
   ```bash
   pnpm dev &
   curl http://localhost:3000/
   ```

## Expected

Either:
- Turbopack honors `turbopack.root` and resolves `tailwindcss` from the
  project's own `node_modules`, OR
- Turbopack warns once (deduplicated) and falls back gracefully.

## Actual

- `GET /` never returns.
- stderr fills with a continuous stream of identical errors:
  ```
  Error: Can't resolve 'tailwindcss' in '<parent-dir>'
  details: "resolve 'tailwindcss' in '<parent-dir>'\n  No description file
    found in <parent-dir> or above\n  ... [hundreds of lines per error]"
  ```
- The same error fires for every CSS chunk for every compile.
- Node RSS climbs from ~340 MB baseline to >1 GB within seconds.
- macOS hosts hit `EAGAIN: resource temporarily unavailable, posix_spawn
  '/bin/sh'` — other tools on the box become unresponsive.
- Removing the stray parent-dir lockfile fully resolves the issue.

## Root cause analysis (best guess)

Three independent issues compound:

1. **`turbopack.root` is not threaded through to the CSS `@import`
   resolver.** The error explicitly says `Can't resolve 'tailwindcss' in
   '<parent-dir>'`, which proves the resolver started above the configured
   root. Other Turbopack pipelines (file tracing) appear to honor the
   setting — only CSS does not.
2. **Workspace root inference treats lockfile *presence* as authoritative
   without validating content.** An empty `{"packages": {}}` lockfile is
   accepted as a real workspace marker.
3. **The Turbopack issue collector has no dedup, no rate limit, and no
   memory cap on resolve-error `details` strings.** Identical errors
   accumulate forever. Combined with the per-error ~30 KB payload, this
   exhausts heap and OS resources.

## Environment

- Next.js 16.2.4
- React 19.2.3
- Tailwind 4.x (via `@tailwindcss/postcss@4.2.1`)
- Node v24.14.0
- pnpm
- macOS 25.4.0 (Darwin) — also expected on Linux/Windows but not verified

## Workaround

Add a `predev` guard that refuses to start the dev server when any
workspace marker exists in the parent directory. See the script we ship
in `scripts/check-parent-workspace.mjs` for an example.

## Suggested fixes

- (1) Make the Turbopack CSS resolver honor `turbopack.root`.
- (2) Skip workspace markers whose `packages` field is empty (or otherwise
  validate that a lockfile actually describes a workspace).
- (3) Dedup identical resolve errors in the Turbopack issue collector and
  cap the retained payload size.

Any one of these three would prevent the catastrophic failure mode.
