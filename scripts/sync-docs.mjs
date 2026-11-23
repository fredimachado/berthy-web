// Downloads Berthy's docs from the berthy repository into src/content/berthy/ (a snapshot that is
// committed) and records the commit it came from. Local sync can fall back to the existing snapshot.
// The Site workflow uses --strict to require a fresh sync.
import { mkdir, writeFile, access } from 'node:fs/promises';

const REPO = 'fredimachado/berthy';
const FILES = ['user-guide.md', 'spec-v1.md'];
const OUT = new URL('../src/content/berthy/', import.meta.url);

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'berthy-web-sync-docs', ...(accept ? { accept } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function exists(file) {
  try {
    await access(new URL(file, OUT));
    return true;
  } catch {
    return false;
  }
}

try {
  // Resolve the commit first, then read the files at that commit, so the snapshot is consistent.
  const commit = await (
    await get(`https://api.github.com/repos/${REPO}/commits/main`, 'application/vnd.github+json')
  ).json();
  const sha = commit.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('GitHub API returned no commit sha');
  const bodies = await Promise.all(
    FILES.map(async (f) => [
      f,
      await (await get(`https://raw.githubusercontent.com/${REPO}/${sha}/docs/${f}`)).text(),
    ]),
  );
  await mkdir(OUT, { recursive: true });
  for (const [f, text] of bodies) await writeFile(new URL(f, OUT), text);
  const source = { repo: REPO, branch: 'main', sha, files: FILES.map((f) => `docs/${f}`) };
  await writeFile(new URL('source.json', OUT), JSON.stringify(source, null, 2) + '\n');
  console.log(`sync-docs: ${FILES.join(', ')} at ${sha.slice(0, 7)}`);
} catch (error) {
  if (process.argv.includes('--strict')) throw error;

  const have = (await Promise.all([...FILES, 'source.json'].map(exists))).every(Boolean);
  console.warn(`sync-docs: WARNING ${error.message}`);
  console.warn(
    have
      ? 'sync-docs: keeping the existing snapshot in src/content/berthy/'
      : 'sync-docs: no snapshot present, the build will fail',
  );
  process.exitCode = have ? 0 : 1;
}
