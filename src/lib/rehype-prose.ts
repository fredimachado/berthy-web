// Small rehype plugin for rendered Markdown: heading anchor links, scrollable tables and
// GitHub-style alerts (`> [!NOTE]`) turned into the same markup `Callout` renders.

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

const ALERTS = {
  NOTE: { kind: 'note', title: 'Note' },
  TIP: { kind: 'tip', title: 'Tip' },
  IMPORTANT: { kind: 'note', title: 'Important' },
  WARNING: { kind: 'warning', title: 'Warning' },
  CAUTION: { kind: 'danger', title: 'Caution' },
  DANGER: { kind: 'danger', title: 'Danger' },
} as const;

const el = (tagName: string, properties: Node['properties'], children: Node[] = []): Node => ({
  type: 'element',
  tagName,
  properties,
  children,
});

function alertOf(node: Node): { kind: string; title: string; body: Node[] } | undefined {
  const kids = (node.children ?? []).filter((c) => !(c.type === 'text' && !c.value?.trim()));
  const first = kids[0];
  if (first?.tagName !== 'p') return undefined;
  const lead = first.children?.[0];
  const match = lead?.type === 'text' ? /^\[!(\w+)\]\s*/.exec(lead.value ?? '') : null;
  const alert = match ? ALERTS[match[1].toUpperCase() as keyof typeof ALERTS] : undefined;
  if (!match || !alert || !lead) return undefined;
  lead.value = (lead.value ?? '').slice(match[0].length);
  const rest = lead.value ? first : { ...first, children: (first.children ?? []).slice(1) };
  const body = [rest, ...kids.slice(1)].filter((n) => n.tagName !== 'p' || n.children?.length);
  return { ...alert, body };
}

function walk(node: Node): void {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    walk(child);
    if (child.type !== 'element') continue;

    if (/^h[2-4]$/.test(child.tagName ?? '') && child.properties?.id) {
      child.children?.push(
        el('a', {
          className: ['heading-anchor'],
          href: `#${child.properties.id}`,
          'aria-label': 'Link to this section',
        }),
      );
    } else if (child.tagName === 'table') {
      kids[i] = el(
        'div',
        { className: ['table-wrap'], tabindex: 0, role: 'group', 'aria-label': 'Table' },
        [child],
      );
    } else if (child.tagName === 'blockquote') {
      const alert = alertOf(child);
      if (alert) {
        kids[i] = el('div', { className: ['callout', `callout-${alert.kind}`], role: 'note' }, [
          el('p', { className: ['callout-title'], 'data-pagefind-ignore': '' }, [
            { type: 'text', value: alert.title },
          ]),
          el('div', { className: ['callout-body'] }, alert.body),
        ]);
      }
    }
  }
}

export function rehypeProse() {
  return (tree: Node) => walk(tree);
}
