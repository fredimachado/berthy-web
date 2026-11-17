// Splits Berthy's two Markdown documents (the user guide and the v1 spec) into documentation pages.
// This file is the one place that decides what a page is, what it is called, where it lives and how
// a link in the original text is rewritten. It is pure (no I/O) and runs under Node's test runner.
//
// Rules, in short:
//   user guide  "## How to read..", "## 1.. 3."   -> one page each, group "Getting started"
//               "### Step N. ..." under "## 4."     -> one page each, group "Step by step"
//               "### ..." under "## 5." and "## 6." -> one page each, group "Reference"
//               "## Contents"                       -> dropped (the sidebar replaces it)
//   spec        every "##"                          -> one page, group "Specification"
//   Headings below a page's own heading move up so the page title is the only h1 and the
//   sub-headings are h2 and h3. Every link in the text is rewritten (see rewriteLinks).
import GithubSlugger from 'github-slugger';

export type GroupId = 'getting-started' | 'step-by-step' | 'reference' | 'specification';

export const REPO = 'fredimachado/berthy';
export const REPO_URL = `https://github.com/${REPO}`;
export const GUIDE_FILE = 'docs/user-guide.md';
export const SPEC_FILE = 'docs/spec-v1.md';

export const GROUPS: { id: GroupId; title: string; description: string }[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'What Berthy is, the words it uses, and the todo app the guide builds on.',
  },
  {
    id: 'step-by-step',
    title: 'Step by step',
    description: 'Deploy and manage one small app, from an empty server to a rebuilt one.',
  },
  {
    id: 'reference',
    title: 'Reference',
    description: 'Every command, manifest key, token scope and file, and what is not there yet.',
  },
  {
    id: 'specification',
    title: 'Specification',
    description: 'The v1 spec: scope, architecture, deploy lifecycle, backups and guardrails.',
  },
];

export type DocPage = {
  /** Entry id and URL tail: "first-deploy", "spec/scope". Stable: derived from the heading text. */
  slug: string;
  url: string;
  /** The page's h1. Steps keep their "Step N." prefix. */
  title: string;
  /** The sidebar label. */
  label: string;
  description: string;
  group: GroupId;
  /** Position in the whole reading order (Prev/Next). */
  order: number;
  /** The file in the berthy repository this page comes from. */
  source: string;
  /** Markdown: headings moved up, links rewritten, no leading heading. */
  body: string;
};

export type LinkStats = { anchors: number; repoFiles: number; external: number; total: number };

export type DocsBuild = {
  pages: DocPage[];
  /** The guide's introduction, for the docs landing page (links rewritten). */
  intro: string;
  stats: LinkStats;
};

export type BrokenLink = { file: string; page: string; link: string; reason: string };

export class BrokenLinksError extends Error {
  broken: BrokenLink[];
  constructor(broken: BrokenLink[]) {
    super(
      `${broken.length} link(s) in the Berthy docs resolve nowhere:\n` +
        broken.map((b) => `  ${b.file} (page "${b.page}"): ](${b.link}) ${b.reason}`).join('\n'),
    );
    this.name = 'BrokenLinksError';
    this.broken = broken;
  }
}

// ---------------------------------------------------------------- scanning

type Line = { text: string; fenced: boolean };
type Heading = { index: number; level: number; text: string };

/** Marks every line as inside a fenced code block or not. Fence lines count as fenced. */
export function scan(markdown: string): Line[] {
  let open: { char: string; length: number } | null = null;
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((text) => {
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
      if (!open) {
        if (fence) {
          open = { char: fence[1][0], length: fence[1].length };
          return { text, fenced: true };
        }
        return { text, fenced: false };
      }
      if (
        fence &&
        fence[1][0] === open.char &&
        fence[1].length >= open.length &&
        fence[2].trim() === ''
      ) {
        open = null;
      }
      return { text, fenced: true };
    });
}

function headingsOf(lines: Line[]): Heading[] {
  const out: Heading[] = [];
  lines.forEach((l, index) => {
    if (l.fenced) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l.text);
    if (m) out.push({ index, level: m[1].length, text: m[2] });
  });
  return out;
}

/** The text of a heading as GitHub (and Astro) slug it: formatting marks removed. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*?/g, '')
    .trim();
}

export function kebab(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The first paragraph, as plain text of at most ~160 characters. */
export function describe(body: string): string {
  const lines = scan(body);
  let para: string[] = [];
  for (const l of lines) {
    if (l.fenced) {
      if (para.length) break;
      continue;
    }
    const t = l.text.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|\||>|---)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = plainText(para.join(' ')).replace(/\s+/g, ' ');
  if (text.length <= 160) return text;
  const cut = text.slice(0, 160);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 100)).replace(/[,;:.\s]+$/, '') + '…';
}

// ---------------------------------------------------------------- sections

/** Cuts `lines` at the headings of `level`: [{heading, body lines}]. Text before the first is `preamble`. */
function cut(
  lines: Line[],
  level: number,
): { preamble: Line[]; parts: { heading: Heading; lines: Line[] }[] } {
  const marks = headingsOf(lines).filter((h) => h.level === level);
  const preamble = lines.slice(0, marks[0]?.index ?? lines.length);
  const parts = marks.map((heading, i) => ({
    heading,
    lines: lines.slice(heading.index + 1, marks[i + 1]?.index ?? lines.length),
  }));
  return { preamble, parts };
}

function trimBlank(lines: Line[]): Line[] {
  let a = 0;
  let b = lines.length;
  const blank = (l: Line) =>
    !l.fenced && (l.text.trim() === '' || /^-{3,}\s*$/.test(l.text.trim()));
  while (a < b && blank(lines[a])) a++;
  while (b > a && blank(lines[b - 1])) b--;
  return lines.slice(a, b);
}

// ---------------------------------------------------------------- the build

type Draft = {
  group: GroupId;
  file: string;
  title: string;
  label: string;
  slug: string;
  /** Level of the page's own heading in the source file. */
  level: number;
  lines: Line[];
  /** Position of the page's heading among all headings of the file. */
  headingIndex: number;
};

const stripNumber = (s: string) => s.replace(/^\d+\.\s+/, '');
const stripStep = (s: string) => s.replace(/^Step\s+\d+\.\s+/, '');

function guideDrafts(
  lines: Line[],
  file: string,
  headings: Heading[],
): { drafts: Draft[]; intro: Line[]; containers: Map<number, GroupId> } {
  const drafts: Draft[] = [];
  const containers = new Map<number, GroupId>(); // heading index of "## 4." / "## 5." -> group
  const { preamble, parts } = cut(lines, 2);
  const indexOf = (line: number) => headings.findIndex((h) => h.index === line);
  const intro = trimBlank(
    preamble.slice(headings.find((h) => h.level === 1) ? headings[0].index + 1 : 0),
  );

  for (const { heading, lines: body } of parts) {
    const text = plainText(heading.text);
    const hi = indexOf(heading.index);
    if (text === 'Contents') continue;
    if (/^4\.\s/.test(text) || /^5\.\s/.test(text)) {
      const group: GroupId = /^4\./.test(text) ? 'step-by-step' : 'reference';
      containers.set(hi, group);
      const sub = cut(body, 3);
      for (const p of sub.parts) {
        const title = plainText(p.heading.text);
        const label = group === 'step-by-step' ? stripStep(title) : title;
        drafts.push({
          group,
          file,
          title,
          label,
          slug: kebab(label),
          level: 3,
          lines: p.lines,
          headingIndex: indexOf(heading.index + 1 + p.heading.index),
        });
      }
      continue;
    }
    const known = /^How to read the commands$/.test(text) || /^[123]\.\s/.test(text);
    const limits = /^6\.\s/.test(text);
    if (!known && !limits) {
      throw new Error(
        `Unexpected section "## ${text}" in ${file}. Add it to guideDrafts() in src/lib/split-guide.ts so it gets a group.`,
      );
    }
    const title = stripNumber(text);
    drafts.push({
      group: limits ? 'reference' : 'getting-started',
      file,
      title,
      label: title,
      slug: kebab(title),
      level: 2,
      lines: body,
      headingIndex: hi,
    });
  }
  return { drafts, intro, containers };
}

function specDrafts(lines: Line[], file: string, headings: Heading[]): Draft[] {
  const { parts } = cut(lines, 2);
  return parts.map(({ heading, lines: body }) => {
    const title = plainText(heading.text);
    return {
      group: 'specification' as const,
      file,
      title,
      label: title,
      slug: `spec/${kebab(title)}`,
      level: 2,
      lines: body,
      headingIndex: headings.findIndex((h) => h.index === heading.index),
    };
  });
}

type Target = { slug: string; local?: string };

export function buildDocs(sources: { guide: string; spec: string }): DocsBuild {
  const files = [
    { file: GUIDE_FILE, lines: scan(sources.guide) },
    { file: SPEC_FILE, lines: scan(sources.spec) },
  ] as const;

  const drafts: Draft[] = [];
  let guideIntro: Line[] = [];
  const containers = new Map<string, Map<number, GroupId>>();
  const headingsByFile = new Map<string, Heading[]>();

  for (const { file, lines } of files) {
    const headings = headingsOf(lines);
    headingsByFile.set(file, headings);
    if (file === GUIDE_FILE) {
      const g = guideDrafts(lines, file, headings);
      drafts.push(...g.drafts);
      guideIntro = g.intro;
      containers.set(file, g.containers);
    } else {
      drafts.push(...specDrafts(lines, file, headings));
    }
  }

  // Order: group order, then position in the file.
  const groupRank = new Map(GROUPS.map((g, i) => [g.id, i]));
  drafts.sort(
    (a, b) =>
      groupRank.get(a.group)! - groupRank.get(b.group)! ||
      (a.file === b.file ? a.headingIndex - b.headingIndex : 0),
  );

  const seen = new Set<string>();
  for (const d of drafts) {
    if (!d.slug || seen.has(d.slug))
      throw new Error(`Two docs pages would share the slug "${d.slug}" (${d.title}).`);
    seen.add(d.slug);
  }

  // Two kinds of id. Global: what a link in the original file points at (github-slugger over the whole
  // file). Local: what Astro gives the heading inside its page (github-slugger over the page body).
  const anchors = new Map<string, Target>(); // "file#global id" -> where it lives now
  for (const [file, headings] of headingsByFile) {
    const global = new GithubSlugger();
    const globalIds = headings.map((h) => global.slug(plainText(h.text)));
    const pagesOfFile = drafts.filter((d) => d.file === file);
    const first = (group: GroupId) => drafts.find((d) => d.group === group)!;

    // Headings that are not pages or inside one: the title, "Contents", and the sections that hold pages.
    headings.forEach((h, i) => {
      if (h.level === 1 || plainText(h.text) === 'Contents') {
        anchors.set(`${file}#${globalIds[i]}`, {
          slug: file === GUIDE_FILE ? '' : first('specification').slug,
        });
      }
    });
    for (const [i, group] of containers.get(file) ?? [])
      anchors.set(`${file}#${globalIds[i]}`, { slug: first(group).slug });

    for (const d of pagesOfFile) {
      anchors.set(`${file}#${globalIds[d.headingIndex]}`, { slug: d.slug });
      let end = d.headingIndex + 1;
      while (end < headings.length && headings[end].level > d.level) end++;
      const local = new GithubSlugger();
      for (let i = d.headingIndex + 1; i < end; i++) {
        anchors.set(`${file}#${globalIds[i]}`, {
          slug: d.slug,
          local: local.slug(plainText(headings[i].text)),
        });
      }
    }
  }

  const urlOf = (t: Target) =>
    (t.slug ? `/docs/${t.slug}/` : '/docs/') + (t.local ? `#${t.local}` : '');
  const broken: BrokenLink[] = [];
  const stats: LinkStats = { anchors: 0, repoFiles: 0, external: 0, total: 0 };

  const resolve =
    (file: string, page: string) =>
    (link: string): string => {
      stats.total++;
      if (/^(https?:|mailto:)/.test(link)) {
        stats.external++;
        return link;
      }
      const hashAt = link.indexOf('#');
      const path = hashAt >= 0 ? link.slice(0, hashAt) : link;
      const frag = hashAt >= 0 ? decodeURIComponent(link.slice(hashAt + 1)) : '';
      // Which file does the link point into?
      let target = file;
      if (path) {
        target = normalizePath(file, path);
        if (target.startsWith('../')) {
          broken.push({ file, page, link, reason: 'points outside the repository' });
          return link;
        }
      }
      if (target === GUIDE_FILE || target === SPEC_FILE) {
        if (!frag) {
          stats.anchors++;
          return target === GUIDE_FILE
            ? '/docs'
            : urlOf({ slug: drafts.find((d) => d.group === 'specification')!.slug });
        }
        const hit = anchors.get(`${target}#${frag}`);
        if (!hit) {
          broken.push({ file, page, link, reason: `no heading "${frag}" in ${target}` });
          return link;
        }
        stats.anchors++;
        return urlOf(hit);
      }
      stats.repoFiles++;
      const folder = path.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(target.split('/').pop() ?? '');
      return `${REPO_URL}/${folder ? 'tree' : 'blob'}/main/${target.replace(/\/$/, '')}${frag ? `#${frag}` : ''}`;
    };

  const pages: DocPage[] = drafts.map((d, order) => {
    const lines = trimBlank(d.lines);
    const shift = d.level - 1;
    const bodyLines = lines.map((l) => {
      if (l.fenced) return l.text;
      const m = /^(#{1,6})(\s+.*)$/.exec(l.text);
      return m ? `${'#'.repeat(Math.max(2, m[1].length - shift))}${m[2]}` : l.text;
    });
    const raw = bodyLines.join('\n');
    return {
      slug: d.slug,
      url: `/docs/${d.slug}/`,
      title: d.title,
      label: d.label,
      description: describe(raw) || d.title,
      group: d.group,
      order,
      source: d.file,
      body: rewriteLinks(raw, resolve(d.file, d.slug)),
    };
  });

  const intro = rewriteLinks(
    trimBlank(guideIntro)
      .map((l) => l.text)
      .join('\n'),
    resolve(GUIDE_FILE, '(intro)'),
  );

  if (broken.length) throw new BrokenLinksError(broken);
  return { pages, intro, stats };
}

function normalizePath(fromFile: string, link: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of link.split('/')) {
    if (seg === '..') {
      if (parts.length === 0) return '../' + link;
      parts.pop();
    } else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- links

/**
 * Rewrites the destination of every Markdown link outside code. `resolve` maps a destination to its
 * new one. Fenced blocks and inline code are left alone, and so are image destinations.
 */
export function rewriteLinks(markdown: string, resolve: (link: string) => string): string {
  return scan(markdown)
    .map((l) => {
      if (l.fenced) return l.text;
      // Mask inline code so a "](" inside it is not a link, while a code span inside the link text is.
      const masked = l.text.replace(/`[^`]*`/g, (m) => 'x'.repeat(m.length));
      let out = '';
      let at = 0;
      for (const m of masked.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g)) {
        const destStart = m.index + m[0].indexOf('](') + 2;
        const dest = l.text.slice(destStart, destStart + m[1].length);
        out += l.text.slice(at, destStart) + resolve(dest);
        at = destStart + m[1].length;
      }
      return out + l.text.slice(at);
    })
    .join('\n');
}
