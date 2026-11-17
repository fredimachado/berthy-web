// Content loader for the "docs" collection: one entry per page that split-guide.ts cuts out of the
// synced snapshot. In dev it reloads when the snapshot changes.
import { fileURLToPath } from 'node:url';
import type { Loader } from 'astro/loaders';
import { loadDocs, sourceDir } from './docs-source.ts';

export function berthyDocsLoader(): Loader {
  return {
    name: 'berthy-docs',
    load: async ({ store, parseData, renderMarkdown, generateDigest, watcher, logger }) => {
      const sync = async () => {
        const { pages, source } = await loadDocs();
        store.clear();
        for (const page of pages) {
          const { body, slug, ...data } = page;
          store.set({
            id: slug,
            data: await parseData({ id: slug, data: { ...data, sha: source.sha } }),
            body,
            digest: generateDigest(body),
            rendered: await renderMarkdown(body),
          });
        }
        logger.info(`${pages.length} pages from berthy@${source.sha.slice(0, 7)}`);
      };
      await sync();

      if (watcher) {
        const dir = fileURLToPath(sourceDir);
        watcher.add(dir);
        watcher.on('change', (file) => {
          if (file.split('\\').join('/').includes('/content/berthy/')) {
            void sync().catch((e) => logger.error(String(e)));
          }
        });
      }
    },
  };
}

// The guide's introduction, rendered once, for the docs landing page.
export function berthyIntroLoader(): Loader {
  return {
    name: 'berthy-docs-intro',
    load: async ({ store, parseData, renderMarkdown, generateDigest }) => {
      const { intro } = await loadDocs();
      store.clear();
      store.set({
        id: 'guide',
        data: await parseData({ id: 'guide', data: {} }),
        body: intro,
        digest: generateDigest(intro),
        rendered: await renderMarkdown(intro),
      });
    },
  };
}
