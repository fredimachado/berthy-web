// Checks the built site (dist/): every internal link points at a page that exists, and every
// #fragment at an id that exists on that page. External links are counted, not fetched.
// Usage: node scripts/check-links.mjs [dist]
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = process.argv[2] ?? 'dist';
const SITE = 'https://berthy.pages.dev';

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const exists = async (p) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

const files = (await walk(root)).filter((f) => f.endsWith('.html'));
const idsOf = new Map(); // url path -> Set of ids
const pagePath = (file) =>
  '/' +
  relative(root, file)
    .split(sep)
    .join('/')
    .replace(/index\.html$/, '');
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const pages = new Map();
for (const file of files) {
  const html = await readFile(file, 'utf8');
  pages.set(pagePath(file), html);
  idsOf.set(
    pagePath(file),
    new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1]))),
  );
}

let internal = 0;
let fragments = 0;
let external = 0;
const broken = [];

for (const [from, html] of pages) {
  for (const m of html.matchAll(/<a\s[^>]*?href="([^"]*)"/g)) {
    const href = decode(m[1]);
    if (/^(mailto:|tel:|javascript:)/.test(href)) continue;
    if (/^https?:\/\//.test(href) && !href.startsWith(SITE)) {
      external++;
      continue;
    }
    internal++;
    const url = new URL(
      href.startsWith(SITE) ? href.slice(SITE.length) || '/' : href,
      `http://x${from}`,
    );
    let path = decodeURIComponent(url.pathname);
    let target = path;
    if (!(await exists(join(root, path)))) {
      // a page: /docs/x/ -> /docs/x/index.html
      const dir = path.endsWith('/') ? path : path + '/';
      if (await exists(join(root, dir, 'index.html'))) target = dir;
      else {
        broken.push(`${from} -> ${href} (no such page)`);
        continue;
      }
    }
    if (url.hash.length > 1) {
      fragments++;
      const id = decodeURIComponent(url.hash.slice(1));
      const ids = idsOf.get(target);
      if (ids && !ids.has(id)) broken.push(`${from} -> ${href} (no element with id "${id}")`);
    }
  }
}

console.log(
  `check-links: ${files.length} pages, ${internal} internal links (${fragments} with a #fragment), ${external} external links not fetched`,
);
if (broken.length) {
  console.error(`check-links: ${broken.length} broken:\n  ` + [...new Set(broken)].join('\n  '));
  process.exit(1);
}
console.log('check-links: no broken internal links');
