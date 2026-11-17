import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildDocs,
  BrokenLinksError,
  describe as describeText,
  kebab,
  rewriteLinks,
  scan,
} from '../src/lib/split-guide.ts';

const snapshot = (name: string) =>
  readFileSync(new URL(`../src/content/berthy/${name}`, import.meta.url), 'utf8');
const real = () => buildDocs({ guide: snapshot('user-guide.md'), spec: snapshot('spec-v1.md') });

// A guide with the same shape as the real one, small enough to read.
const tiny = (extra = '', stepBody = 'Body.') =>
  [
    '# Guide',
    'Intro with [a file](../examples/todo/).',
    '## Contents',
    '1. [One](#step-1-one)',
    '## How to read the commands',
    'Read.',
    '## 1. What Berthy is',
    'Is.',
    '## 2. Words you will see',
    'Words.',
    '## 3. The todo app',
    'App.',
    '## 4. Step by step',
    '### Step 1. One',
    stepBody,
    '#### Sub one',
    'Text.',
    '##### Deeper',
    'Text.',
    '### Step 2. Two',
    '#### Sub one',
    'Again.',
    '## 5. Reference',
    '### Commands',
    'Cmds.',
    '## 6. Limits and what is not there yet',
    'None.',
    extra,
  ].join('\n');
const tinySpec = '# Spec\nSpec intro.\n## Summary\nSum.\n### Part\nText.\n';
const build = (guide: string, spec = tinySpec) => buildDocs({ guide, spec });

test('the real docs split into the expected groups and pages', () => {
  const { pages } = real();
  const count = (g: string) => pages.filter((p) => p.group === g).length;
  assert.equal(count('getting-started'), 4);
  assert.equal(count('step-by-step'), 15);
  assert.equal(count('reference'), 9);
  assert.equal(count('specification'), 18);
  assert.equal(pages.length, 46);
  assert.deepEqual(
    pages.map((p) => p.order),
    pages.map((_, i) => i),
  );
});

test('slugs are stable and unique (a change here breaks published URLs)', () => {
  const slugs = real().pages.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual(slugs.slice(0, 8), [
    'how-to-read-the-commands',
    'what-berthy-is',
    'words-you-will-see',
    'the-todo-app',
    'prepare-a-server-and-set-it-up',
    'write-the-manifest',
    'registry-credentials-and-secrets',
    'the-first-deploy',
  ]);
  assert.ok(slugs.includes('manifest-keys'));
  assert.ok(slugs.includes('limits-and-what-is-not-there-yet'));
  assert.ok(slugs.includes('spec/deploy-lifecycle'));
});

test('steps keep their number in the title and lose it in the label', () => {
  const step = real().pages.find((p) => p.slug === 'the-first-deploy')!;
  assert.equal(step.title, 'Step 4. The first deploy');
  assert.equal(step.label, 'The first deploy');
});

test('every link in the real docs resolves: none is left pointing at "#" or a relative file', () => {
  const { pages, intro, stats } = real();
  assert.ok(
    stats.anchors >= 18,
    `expected the guide's in-page links to be counted, got ${stats.anchors}`,
  );
  for (const text of [intro, ...pages.map((p) => p.body)]) {
    for (const l of scan(text)) {
      if (l.fenced) continue;
      for (const m of l.text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)/g)) {
        assert.match(m[1], /^(\/docs|https:\/\/)/, `unrewritten link ](${m[1]})`);
      }
    }
  }
});

test('anchor links point at the page that holds the heading, with the id Astro will give it', () => {
  const { pages } = real();
  const body = (slug: string) => pages.find((p) => p.slug === slug)!.body;
  // Step 4 links to its own sub-heading and to the spec; step 2 links to step 6.
  assert.match(
    body('the-first-deploy'),
    /\]\(\/docs\/the-first-deploy\/#all-the-apps-in-one-command\)/,
  );
  assert.match(body('write-the-manifest'), /\]\(\/docs\/ship-a-new-version-of-the-api\/\)/);
  assert.match(body('the-first-deploy'), /\]\(\/docs\/spec\/adopting-an-existing-deployment\/\)/);
  // "#token-scopes" is a page of its own; "#connect-an-ai-agent-through-mcp" a sub-heading of step 11.
  const all = pages.map((p) => p.body).join('\n');
  assert.match(all, /\]\(\/docs\/token-scopes\/\)/);
  assert.match(
    all,
    /\]\(\/docs\/protected-environments-and-ai-agents\/#connect-an-ai-agent-through-mcp\)/,
  );
});

test('a link to a repository file becomes a GitHub URL: tree for folders, blob for files', () => {
  const r = build(
    tiny(
      '',
      'See [plan](implementation-plan-v1.md) and [dir](../examples/todo/) and [x](../deploy/x.yml#l3).',
    ),
  );
  const step = r.pages.find((p) => p.slug === 'one')!;
  assert.match(
    step.body,
    /\]\(https:\/\/github\.com\/fredimachado\/berthy\/blob\/main\/docs\/implementation-plan-v1\.md\)/,
  );
  assert.match(
    step.body,
    /\]\(https:\/\/github\.com\/fredimachado\/berthy\/tree\/main\/examples\/todo\)/,
  );
  assert.match(
    step.body,
    /\]\(https:\/\/github\.com\/fredimachado\/berthy\/blob\/main\/deploy\/x\.yml#l3\)/,
  );
  assert.match(r.intro, /tree\/main\/examples\/todo/);
});

test('an anchor that resolves nowhere fails the build and says which', () => {
  assert.throws(
    () => build(tiny('', 'Go to [there](#no-such-heading) and [spec](spec-v1.md#nope).')),
    (e: unknown) => {
      assert.ok(e instanceof BrokenLinksError);
      assert.equal(e.broken.length, 2);
      assert.match(e.message, /no-such-heading/);
      assert.match(e.message, /page "one"/);
      assert.match(e.message, /nope/);
      return true;
    },
  );
});

test('a section the splitter does not know is an error, not a silently dropped page', () => {
  assert.throws(
    () => build(tiny('## 7. Something new\nText.')),
    /Unexpected section "## 7\. Something new"/,
  );
});

test('headings inside code fences are neither pages nor anchors, and are not moved', () => {
  const r = build(
    tiny(
      '',
      'Run:\n\n```bash\n# a comment, not a heading\n## also not\n```\n\nThen [back](#sub-one).',
    ),
  );
  const step = r.pages.find((p) => p.slug === 'one')!;
  assert.match(step.body, /```bash\n# a comment, not a heading\n## also not\n```/);
  assert.equal(r.pages.length, 4 + 2 + 1 + 1 + 1);
});

test('headings below a page move up: the page title is the only h1, sub-headings are h2 and h3', () => {
  const step = build(tiny()).pages.find((p) => p.slug === 'one')!;
  assert.match(step.body, /^## Sub one$/m);
  assert.match(step.body, /^### Deeper$/m);
  assert.doesNotMatch(step.body, /^#### /m);
  const spec = build(tiny()).pages.find((p) => p.slug === 'spec/summary')!;
  assert.match(spec.body, /^## Part$/m);
});

test('the same heading on two pages gets the same local id on each; duplicates inside a page are numbered', () => {
  // "Sub one" is in step 1 and step 2: in the original file the second is "sub-one-1".
  const r = build(tiny('', 'Link to [two](#sub-one-1) and [one](#sub-one).'));
  const step = r.pages.find((p) => p.slug === 'one')!;
  assert.match(step.body, /\]\(\/docs\/two\/#sub-one\)/);
  assert.match(step.body, /\]\(\/docs\/one\/#sub-one\)/);
});

test('links inside inline code or fences are left alone; a code span in link text still counts', () => {
  const seen: string[] = [];
  const out = rewriteLinks(
    '`[x](#a)` and [`code`](#b)\n```\n[y](#c)\n```\n![img](#d)',
    (l) => (seen.push(l), '/r'),
  );
  assert.deepEqual(seen, ['#b']);
  assert.match(out, /\[`code`\]\(\/r\)/);
  assert.match(out, /`\[x\]\(#a\)`/);
});

test('kebab and describe', () => {
  assert.equal(kebab('Look at `it`, now!'), 'look-at-it-now');
  const body =
    '```\ncode\n```\n\nThe **first** paragraph has `code` and a [link](/x).\nIt goes on.\n\nSecond.';
  assert.equal(describeText(body), 'The first paragraph has code and a link. It goes on.');
  assert.ok(describeText('word '.repeat(80)).length <= 162);
});
