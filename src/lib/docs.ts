export type NavItem = { label: string; href: string };
export type NavGroup = { title: string; items: NavItem[] };
export type TocItem = { depth: number; slug: string; text: string };
export type Crumb = { label: string; href?: string };

export const flatNav = (groups: NavGroup[]): (NavItem & { group: string })[] =>
  groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })));

/** The previous and next page of `href` in reading order. */
export function neighbours(groups: NavGroup[], href: string) {
  const flat = flatNav(groups);
  const i = flat.findIndex((p) => p.href === href);
  return { prev: i > 0 ? flat[i - 1] : undefined, next: i >= 0 ? flat[i + 1] : undefined };
}
