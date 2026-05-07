#!/usr/bin/env node
// Predev guard. Refuses to start `next dev` if the parent directory contains
// stray workspace markers that would trick Next.js 16 / Turbopack into
// treating the parent as the workspace root.
//
// Background: Turbopack's CSS @import resolver does not honor
// `turbopack.root` in next.config.ts. When it walks up from a CSS file and
// finds a lockfile or package.json one level above the project, it treats
// that level as the workspace root and resolves all `@import "tailwindcss"`
// from there — failing catastrophically (infinite resolve-error loop, OOM,
// OS fork pool exhaustion).
//
// See CLAUDE.md → "Parent-workspace trap" for the full story.

import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const PARENT = dirname(PROJECT_ROOT);

const WORKSPACE_MARKERS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pnpm-workspace.yaml',
  'bun.lockb',
];

const found = WORKSPACE_MARKERS
  .map((name) => join(PARENT, name))
  .filter(existsSync);

if (found.length === 0) {
  process.exit(0);
}

const list = found.map((f) => `    - ${f}`).join('\n');
const rmCmd = `rm ${found.map((f) => `'${f}'`).join(' ')}`;

console.error(`
\x1b[31m[predev guard] Stray workspace marker(s) detected in parent directory.\x1b[0m

  parent: ${PARENT}
  files:
${list}

These trick Next.js 16 / Turbopack into treating the parent as the workspace
root. The CSS @import resolver does not honor 'turbopack.root' in
next.config.ts, so 'globals.css' fails to resolve 'tailwindcss', logs a
~30 KB resolve trace per CSS chunk, and exhausts heap + OS fork pool within
seconds. The dev server hangs and the host machine becomes unresponsive.

\x1b[33mFix:\x1b[0m
  ${rmCmd}

If the parent directory is intentionally a workspace, do NOT remove these.
Instead, pin the project's own boundary explicitly and keep this guard
disabled until you have a verified fix.

See: CLAUDE.md → "Parent-workspace trap" for full background.
`);

process.exit(1);
