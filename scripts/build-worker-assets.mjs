import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'public');
const files = [
  'index.html',
  'config.js',
  'search-core.js',
  'places-search.js',
  'search-ui.js',
  'search.css',
  'privacy.html',
  'terms.html',
  'icons/app-icon.svg',
  'icons/apple-touch-icon.png',
  'icons/favicon.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// Only these public files may be uploaded. Never copy the repository root,
// backend code, local secrets, documentation, or dependency directories.
for (const file of files) {
  if (!(await lstat(join(root, file))).isFile()) {
    throw new Error(`Expected a regular static asset: ${file}`);
  }
}

// Rebuild from the allowlist so removed or accidental files cannot linger.
await rm(output, { recursive: true, force: true });
for (const file of files) {
  const destination = join(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, file), destination);
}

console.log(`Prepared ${files.length} static assets for the existing Worker.`);
