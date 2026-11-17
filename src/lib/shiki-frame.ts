import type { ShikiTransformer } from 'shiki';

// The one place that decides what a code block looks like. It wraps Shiki's <pre> in a frame
// (optional title bar, copy button) and marks highlighted lines. Both the `CodeBlock` component and
// fenced blocks in Markdown go through it, driven by the same meta string:
//
//   ```bash title="deploy.sh" {2,4-5}
//
// The copy button is wired by src/scripts/copy.ts.

type Node = { type: string; [key: string]: unknown };
type El = {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: Node[];
};

const el = (tagName: string, properties: El['properties'], children: Node[] = []): El => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const text = (value: string): Node => ({ type: 'text', value });

export type CodeMeta = { title?: string; highlight: Set<number> };

/** Parse `title="..."` and `{1,3-5}` out of a fence meta string. */
export function parseCodeMeta(raw: string | undefined): CodeMeta {
  const meta: CodeMeta = { highlight: new Set() };
  if (!raw) return meta;
  const title = /title=(?:"([^"]*)"|'([^']*)')/.exec(raw);
  if (title) meta.title = title[1] ?? title[2];
  const ranges = /\{([\d,\s-]+)\}/.exec(raw);
  if (ranges) {
    for (const part of ranges[1].split(',')) {
      const [from, to = from] = part.trim().split('-').map(Number);
      if (Number.isInteger(from) && Number.isInteger(to)) {
        for (let n = from; n <= to; n++) meta.highlight.add(n);
      }
    }
  }
  return meta;
}

export function shikiFrame(): ShikiTransformer {
  let meta: CodeMeta = { highlight: new Set() };
  return {
    name: 'berthy-frame',
    preprocess() {
      meta = parseCodeMeta(this.options.meta?.__raw);
    },
    line(node, line) {
      if (meta.highlight.has(line)) this.addClassToHast(node, 'highlighted');
    },
    root(root) {
      const pre = root.children[0] as unknown as El;
      const lang = String(this.options.lang ?? 'text');
      const copy = el(
        'button',
        {
          type: 'button',
          className: ['copy-btn'],
          'data-copy-from': 'pre',
          // The frame is chrome, not content: keep it out of the search index.
          'data-pagefind-ignore': '',
        },
        [el('span', { className: ['sr-only'], 'data-copy-label': '' }, [text('Copy code')])],
      );

      const children: Node[] = [];
      if (meta.title) {
        children.push(
          el('figcaption', { className: ['codeblock-bar'], 'data-pagefind-ignore': '' }, [
            el('span', { className: ['codeblock-title'] }, [text(meta.title)]),
            el('span', { className: ['codeblock-lang'] }, [text(lang)]),
            copy,
          ]),
        );
      } else {
        children.push(copy);
      }
      children.push(pre);
      root.children = [
        el(
          'figure',
          {
            className: ['codeblock', meta.title ? 'has-title' : 'no-title'],
            'data-lang': lang,
          },
          children,
        ),
      ] as never;
    },
  };
}
