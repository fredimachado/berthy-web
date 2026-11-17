export const SITE = {
  name: 'Berthy',
  tagline: 'Deploy and run apps on your own Docker servers.',
  description:
    'Berthy deploys and runs apps on your own Docker servers. One Go binary is the agent on the server, the CLI, a terminal UI and an MCP server for AI agents.',
  repo: 'https://github.com/fredimachado/berthy',
  examples: 'https://github.com/fredimachado/berthy-examples',
  releases: 'https://github.com/fredimachado/berthy/releases',
  /** The latest release, as the README names it. */
  release: 'v0.1.0',
} as const;

export type NavLink = { label: string; href: string; external?: boolean };

export const primaryNav: NavLink[] = [
  { label: 'Docs', href: '/docs/' },
  { label: 'Compare', href: '/#compare' },
  { label: 'Releases', href: SITE.releases, external: true },
];

export type Version = { label: string; href: string; note?: string; external?: boolean };

// The docs follow the main branch of the berthy repository. Released versions live on GitHub.
export const versions: Version[] = [
  { label: 'main', href: '/docs/', note: 'these docs' },
  { label: 'Releases', href: SITE.releases, note: SITE.release, external: true },
];

export const footerLinks: { title: string; links: NavLink[] }[] = [
  {
    title: 'Docs',
    links: [
      { label: 'Documentation', href: '/docs/' },
      { label: 'Step by step', href: '/docs/prepare-a-server-and-set-it-up/' },
      { label: 'Reference', href: '/docs/commands/' },
      { label: 'Specification', href: '/docs/spec/summary/' },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'GitHub', href: SITE.repo, external: true },
      { label: 'Releases', href: SITE.releases, external: true },
      { label: 'berthy-examples', href: SITE.examples, external: true },
    ],
  },
  {
    title: 'This site',
    links: [
      { label: 'How Berthy compares', href: '/#compare' },
      { label: 'Design system', href: '/design' },
    ],
  },
];
