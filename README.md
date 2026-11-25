# McMaster Marching Band

pnpm + Turborepo monorepo for the public website, admin dashboard, and Discord upload bot.

| Package | Role | Local URL |
| --- | --- | --- |
| `apps/website/` | Astro static pages + Cloudflare Pages Functions | http://localhost:4323 |
| `apps/admin-dashboard/` | React admin UI + Cloudflare Worker API | http://localhost:5174 |
| `apps/discord-bot/` | Discord channel watcher for gallery photo uploads | Discord Gateway |
| `packages/gallery/` | Shared gallery schema, limits, and helpers | — |
| `packages/content/` | Shared editable-page schema, validator, renderer, seeder | — |
| Local Worker API / R2 | Started with `pnpm dev:admin` | http://localhost:8787 |

## Architecture & Data Sources

- **Public Website (`apps/website`)**: Static Astro build (`apps/website/src/data/prepared-site.json` + `/original/` assets). Cloudflare Pages Functions serve live gallery/page data from the private `mmb-media` R2 bucket (`MEDIA`), using `HTMLRewriter` middleware to inject published page HTML, SEO tags, and JSON-LD at the edge with clean URLs (`/faq`, `/our-team`, `/budget`, `/constitution`, `/executive-meeting-minutes`).
- **Admin Dashboard (`apps/admin-dashboard`)**: Manages both the media gallery and editable pages behind Cloudflare Access (auto-bypassed on loopback in local dev). Uses optimistic locking (`expectedRevision` / `expectedUpdatedAt`) and magic-byte validation for uploaded images and documents.
- **Shared R2 Bucket (`mmb-media`)**: Stores `gallery/v1/catalog.json`, `media/*`, `original/*`, `content/v1/pages/<slug>.json`, `content/v1/history/<slug>/*`, `content/v1/cache/drive/<folderId>.json`, and `content/assets/*`.
- **Optional Integrations**:
  - **GitHub content repo** (`CONTENT_GITHUB_*`): Dual-writes page revisions for git history and rollback; falls back to R2 history when unconfigured.
  - **Google Drive API v3** (`GOOGLE_DRIVE_API_KEY`): Syncs shared Meeting Minutes folders into R2 cache with background edge refresh.
  - **Discord Bot (`apps/discord-bot`)**: Uploads channel image attachments directly to `mmb-media` via S3 credentials.

## Quick Start

```sh
pnpm install
pnpm dev
```

No `.env` file is required for local website/admin development. Local R2 storage (`apps/admin-dashboard/.wrangler/state/`) is automatically seeded once on startup when uninitialized; restarting never overwrites local edits.

## Environment Files

| File | Scope | Purpose |
| --- | --- | --- |
| `.env.example` | Root Node scripts & Discord bot | R2 S3 keys, Discord bot token/channel, optional Cloudflare API token |
| `apps/admin-dashboard/.dev.vars.example` | Worker & Pages Functions | Cloudflare Access (`ACCESS_*`), GitHub history (`CONTENT_GITHUB_*`), Google Drive (`GOOGLE_DRIVE_API_KEY`) |
| `apps/website/.env.example` | Astro frontend | Optional `PUBLIC_GALLERY_API_URL` override |

## Common Commands

```sh
pnpm check             # Type-check all apps and packages
pnpm test              # Run unit and integration test suites
pnpm build             # Build website, admin dashboard, and Worker
pnpm pages:seed-local  # Re-seed local R2 editable pages if needed
pnpm deploy:pages      # Deploy website and admin dashboard to Cloudflare Pages
pnpm release           # Deploy website, admin dashboard, and Discord bot
```

## Production

- **Website**: `https://mmb.nickly.me` (Pages project `mmb-website`)
- **Admin**: `https://admin.mmb.nickly.me` (Pages project `mmb-admin-dashboard`, protected by Cloudflare Access)
- See `apps/website/README.md` for capture/QA details and `apps/discord-bot/README.md` for PM2 bot deployment.
