# berthy-web

The website for [Berthy](https://github.com/fredimachado/berthy): the home page, and the
documentation built from the berthy repository's user guide and v1 spec, with search.

Astro 7, Tailwind CSS 4 (tokens in CSS with `@theme`), Shiki for code, Geist and Geist Mono
self-hosted through Fontsource, Lucide icons inlined at build time, Pagefind for search. No UI
framework: a few small vanilla scripts (theme, copy, tabs, search palette, menus, scroll spy).

## Commands

```sh
npm install
npm run dev          # http://localhost:4321 (search needs the built site)
npm run sync-docs    # refresh the docs snapshot from the berthy repository
npm run build        # sync-docs, astro build, then the Pagefind index, into dist/
npm run preview      # serve dist/ (the search works here)
npm run check        # astro check (types, templates)
npm test             # unit tests for the docs splitter (node --test)
npm run check:links  # every internal link and #fragment in dist/ resolves
npm run format       # Prettier with the Astro plugin
```

Node 24 (`.nvmrc`).

## Pages

- `/` the home page. Every claim on it is in the berthy README or user guide.
- `/docs/` the docs landing page, and `/docs/<slug>/` for each page (46 pages, four groups).
- `/design/` and `/design/docs-sample/` the design system showcase and a sample docs page. They are
  linked from the footer, marked `noindex` and left out of the sitemap.
- `/404.html`, `/sitemap-index.xml`, `/robots.txt`, `/og.png` (the 1200x630 social image).

## Where the docs come from

The content is not written here. `scripts/sync-docs.mjs` downloads `docs/user-guide.md` and
`docs/spec-v1.md` from the berthy repository (`main`, at one commit) into `src/content/berthy/`, and
writes the commit it used to `source.json`. That snapshot is committed, so the site builds offline:
if the download fails, the script warns and keeps the snapshot.

`src/lib/split-guide.ts` is the single place that turns the two files into pages. It is pure and
unit-tested (`tests/split-guide.test.ts`):

| Source                                                                                             | Becomes                                                                                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Guide: "How to read the commands", "1. What Berthy is", "2. Words you will see", "3. The todo app" | **Getting started**, 4 pages                                                                  |
| Guide: each "### Step N. Title" of "4. Step by step"                                               | **Step by step**, 15 pages. The page title keeps "Step N."; the sidebar label and slug do not |
| Guide: each "###" of "5. Reference", and "6. Limits and what is not there yet"                     | **Reference**, 9 pages                                                                        |
| Spec: each "##"                                                                                    | **Specification**, 18 pages at `/docs/spec/<slug>/`                                           |

- "## Contents" is dropped (the sidebar replaces it); the guide's introduction is the docs landing page.
- A page's sub-headings move up one or two levels, so the page title is the only h1.
- Slugs are the heading in kebab case without numbering, for example `the-first-deploy`. A test pins
  them, because changing one breaks published URLs.
- Every `](#anchor)` link is rewritten to the page that holds the heading, plus `#id` for a
  sub-heading. A link into the other file (`spec-v1.md#...`) works the same way. Links to files in the
  repository become `https://github.com/fredimachado/berthy/blob/main/<path>` (or `/tree/main/` for
  folders). **A link that resolves nowhere fails the build and names the page and the link.** So does a
  new `##` section in the guide that the splitter does not know: add it to `guideDrafts()`.
- `src/lib/docs-loader.ts` is the content-collection loader that turns the pages into the `docs`
  collection; `src/lib/docs-source.ts` reads the snapshot.

## Search

The Cmd/Ctrl+K palette loads Pagefind (`/pagefind/pagefind.js`) the first time it opens. Only the
article of a docs page is indexed (`data-pagefind-body`), under its group name. In `astro dev` there is
no index, and the palette says so.

## Install scripts

`public/install.sh` (Linux and macOS) and `public/install.ps1` (Windows) are served at `/install.sh` and
`/install.ps1`, as plain text (`public/_headers`). The home page leads with them:

```bash
curl -fsSL https://berthy.pages.dev/install.sh | sh
```

```powershell
irm https://berthy.pages.dev/install.ps1 | iex
```

Each downloads `berthy-<os>-<arch>` and `checksums.txt` from the latest release of the berthy repository,
stops when the hash does not match, and installs the binary: `/usr/local/bin/berthy` (with `sudo` when
needed), or `%LOCALAPPDATA%\Programs\berthy\berthy.exe`, whose folder is added to the user PATH. Neither
names a version, so a new release needs no change here. The settings (`BERTHY_VERSION`,
`BERTHY_INSTALL_DIR`, `BERTHY_RELEASE_URL`, and `BERTHY_NO_MODIFY_PATH` on Windows) are listed at the top
of each script. The scripts name `berthy.pages.dev` in their comments and messages; change it there too if
a custom domain replaces it. `.gitattributes` keeps `install.sh` on LF line endings.

## Deploying: Cloudflare Pages

`.github/workflows/site.yml` checks and builds on every push and pull request, and on a daily schedule
that picks up documentation changes in the berthy repository. On main, the schedule and a manual run it
also deploys `dist/` to the Cloudflare Pages project `berthy`, when both secrets exist. Without them
the deploy job ends with a notice.

The Pages project `berthy` exists as a "Direct Upload" project with `main` as its production branch,
served at `https://berthy.pages.dev`. The deploy needs two repository secrets:

1. `CLOUDFLARE_ACCOUNT_ID`: the id of the Cloudflare account that owns the project.
2. `CLOUDFLARE_API_TOKEN`: an API token with **Account → Cloudflare Pages → Edit**.

`site` in `astro.config.mjs` is `https://berthy.pages.dev` (canonical URLs and the sitemap come from it); change it, `SITE`
in `scripts/check-links.mjs` and the `Sitemap` line in `public/robots.txt` if a custom domain replaces it. Dependabot updates npm packages and
actions weekly. Every action in the workflow is pinned by commit SHA.

## Design system

Tokens are in `src/styles/global.css`: raw scales (`ink`, `berth`), semantic roles that switch with the
theme (`bg`, `surface`, `fg`, `accent`, and so on), type, radii, shadows and motion. Components in
`src/components` use roles only. `/design` shows all of it, with live contrast ratios.

- **Colour:** continuity with the terminal UI. `berth` (the accent, violet) keeps the TUI's accent at 400
  (`#9d8cff`, dark) and 600 (`#5b3fd9`, light).
- **Type:** Geist for the interface and headings, Geist Mono for code.
- **Logo:** a "B" drawn as a quay post with two berths moored to it (`src/components/Logo.astro`).
- **Layout of the docs**, after Laravel's: top bar, collapsible sidebar, the article, and "On this
  page". Below `lg` the sidebar is a drawer; below `xl` the table of contents hides.

Rendered Markdown gets its code blocks, heading anchors, tables and `> [!NOTE]` callouts from
`src/lib/shiki-frame.ts` and `src/lib/rehype-prose.ts`.

## Accessibility

Skip link, landmarks, visible focus, keyboard-operable menus, tabs and palette (a native `<dialog>`),
`aria-current` for the current page, `prefers-reduced-motion` respected. axe-core (WCAG 2.2 AA and
best-practice rules) reports nothing on the home page, docs pages and 404, in light and dark, at 390,
768 and 1440px.

## License

MIT. See [LICENSE](LICENSE).
