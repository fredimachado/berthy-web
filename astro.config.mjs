// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import { unified, rehypeHeadingIds } from '@astrojs/markdown-remark';
import { berthyThemes } from './src/lib/berthy-themes';
import { shikiFrame } from './src/lib/shiki-frame';
import { rehypeProse } from './src/lib/rehype-prose';

// https://astro.build/config
export default defineConfig({
  site: 'https://berthy-web.pages.dev',
  // Each page is /path/index.html: the URLs Pagefind and the sitemap list end in a slash.
  trailingSlash: 'always',
  integrations: [sitemap({ filter: (page) => !page.includes('/design') })],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // Fenced blocks, tables and alerts get Berthy's markup from these (see src/lib).
    // rehypeHeadingIds runs first so rehypeProse can link to the heading ids.
    processor: unified({ rehypePlugins: [rehypeHeadingIds, rehypeProse] }),
    shikiConfig: {
      themes: berthyThemes,
      // The colours come from CSS variables, switched by the `.dark` class (see global.css).
      defaultColor: false,
      transformers: [shikiFrame()],
    },
  },
});
