import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { berthyDocsLoader, berthyIntroLoader } from './lib/docs-loader.ts';

const docs = defineCollection({
  loader: berthyDocsLoader(),
  schema: z.object({
    url: z.string(),
    title: z.string(),
    label: z.string(),
    description: z.string(),
    group: z.enum(['getting-started', 'step-by-step', 'reference', 'specification']),
    order: z.number(),
    /** The file in the berthy repository this page comes from, e.g. "docs/user-guide.md". */
    source: z.string(),
    /** The berthy commit the snapshot was taken at. */
    sha: z.string(),
  }),
});

const intro = defineCollection({ loader: berthyIntroLoader(), schema: z.object({}) });

export const collections = { docs, intro };
