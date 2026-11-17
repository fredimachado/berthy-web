// The docs collection, as the pages and the sidebar need it.
import { getCollection, type CollectionEntry } from 'astro:content';
import { GROUPS } from './split-guide.ts';
import type { NavGroup } from './docs.ts';

export type DocEntry = CollectionEntry<'docs'>;

/** All pages, in reading order. */
export async function getDocs(): Promise<DocEntry[]> {
  return (await getCollection('docs')).sort((a, b) => a.data.order - b.data.order);
}

export function buildNav(entries: DocEntry[]): NavGroup[] {
  return GROUPS.map((g) => ({
    title: g.title,
    items: entries
      .filter((e) => e.data.group === g.id)
      .map((e) => ({ label: e.data.label, href: e.data.url })),
  })).filter((g) => g.items.length > 0);
}

export async function getNav(): Promise<NavGroup[]> {
  return buildNav(await getDocs());
}
