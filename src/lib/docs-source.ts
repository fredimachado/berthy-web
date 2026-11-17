// Reads the committed snapshot of Berthy's docs (src/content/berthy/, see scripts/sync-docs.mjs) and
// builds the pages with split-guide.ts. Shared by the content loader and the pages that need the
// guide's introduction or the commit the snapshot came from.
import { readFile } from 'node:fs/promises';
import { buildDocs, type DocsBuild } from './split-guide.ts';

export type DocsSource = { repo: string; branch: string; sha: string; files: string[] };

const dir = new URL('../content/berthy/', import.meta.url);

export async function readSource(): Promise<DocsSource> {
  return JSON.parse(await readFile(new URL('source.json', dir), 'utf8'));
}

export async function loadDocs(): Promise<DocsBuild & { source: DocsSource }> {
  const [guide, spec, source] = await Promise.all([
    readFile(new URL('user-guide.md', dir), 'utf8'),
    readFile(new URL('spec-v1.md', dir), 'utf8'),
    readSource(),
  ]);
  return { ...buildDocs({ guide, spec }), source };
}

export const sourceDir = dir;
