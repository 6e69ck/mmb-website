# McMaster Marching Band monorepo

The apps share a pnpm workspace and Turborepo. Runnable applications live in `apps/`; shared code lives in `packages/`.

| Project | Purpose | Local address |
| --- | --- | --- |
| `apps/website/` | Existing Astro site and React islands | http://localhost:4323 |
| `apps/admin-dashboard/` | React gallery manager and Cloudflare Worker API | http://localhost:5174 |
| `apps/discord-bot/` | Discord image uploads and gallery publishing | Discord Gateway process |
| `packages/gallery/` | Shared media types, limits, and gallery helpers | — |
| Admin API / local R2 | Started with the dashboard | http://localhost:8787 |

## Run everything

```sh
pnpm install
pnpm dev
```

One command starts the apps with HMR and the local R2-backed API. The Discord bot also starts when its token and channel are configured; its uploads target the real bucket and gallery. Without Discord configuration, its development process stays in standby. A fresh local gallery is seeded automatically with the existing **372 photos and 12 videos**. The seed runs only when the catalog revision is zero; restarting never overwrites admin edits, even if the gallery has been emptied.

Local development uses local R2 storage under `apps/admin-dashboard/.wrangler/state/`, never the real bucket. It simulates the configured admin on loopback addresses only. The local bypass cannot authenticate production requests.

```sh
pnpm build               # Turbo builds the website, dashboard, and Worker
pnpm check               # Type checks both apps
pnpm test                # Backend authorization, R2, upload, and concurrency tests
pnpm test:batch-upload   # With pnpm dev running: real 100-file mixed upload/retry/cancel QA in local R2
pnpm build --qa          # Builds, then runs browser CRUD + live-gallery checks
pnpm dev:website         # Website only
pnpm dev:admin           # Dashboard and API only
pnpm dev:bot             # Discord bot only; uses the real channel and bucket
pnpm bot:check-config    # Validate the bot environment without connecting
pnpm deploy:bot          # Pull/build only the bot on dev@192.18.151.14 and start it in PM2
pnpm test:deploy-bot     # Local deployment-script integration tests; no server connection
pnpm gallery:seed-local  # Seed an uninitialized local gallery explicitly
pnpm images:migrate     # Upload every original website image to R2
```

## What admins can do

Sign in, upload up to 100 photos and MP4/WebM videos together, add YouTube links, edit captions/descriptions and years, publish or hide items, and remove media. Use the centered year selector and arrows to navigate the library, or select All years. Photos and uploaded-video posters get thumbnails and BlurHash previews in the browser. Two files are processed at a time, with chunked uploads, per-file progress, cancellation, and retries that reuse staged media. Stable request IDs prevent duplicate items after a lost save response. Shared upload metadata locks once saving begins so retries retain the original request. Completed items remain saved when an upload is canceled; uncertain saves are reconciled before their files can be discarded.

The public gallery reads the live catalog and year collections; adding a year, changing captions, hiding, or removing media requires no website rebuild. Changes appear on the next gallery navigation/reload, on focus, or within the periodic refresh. The captured archive remains as an explicitly labeled startup fallback if the service cannot be reached; after a live connection succeeds, stale snapshots are never resurrected.

## Cloudflare Pages production

- **Website:** `https://mmb.nickly.me` — Pages project `mmb-website`.
- **Admin:** `https://admin.mmb.nickly.me` — Pages project `mmb-admin-dashboard`.
- **Existing private bucket:** `mmb-media`, runtime binding `MEDIA` in both projects.
- **Sign-in:** Cloudflare Access email codes, allowlisted to `nickly88@pm.me`.

The website is built as static Astro pages. Pages Functions serve the live published gallery at `/api/gallery`, gallery files at `/media/`, and the 937 original images at `/original/` from private R2. Fonts, stylesheets, documents, and scripts remain static Pages assets. The deploy staging step removes image files from the Pages upload while preserving the complete local build. Public gallery URLs use the website's origin.

The admin uses Pages advanced mode for its React assets and gallery API. Dashboard, asset, and API routes pass through signed Cloudflare Access JWT verification. Only `/.well-known/acme-challenge/*` bypasses Access and the Worker so Cloudflare can provision and renew the domain certificate. Admin mutations verify the request origin and a dashboard header. Missing Access settings disable administration; drafts are never exposed on the public website. Video byte ranges are supported. R2 S3 credentials are used only for migration; deployed projects use the R2 binding.

### One-time setup / deployment

Authenticate Wrangler and enable Cloudflare Zero Trust for the Soldr account. The ignored root `.env` can contain a separate `CLOUDFLARE_API_TOKEN` with account permissions **Access: Apps and Policies — Edit**, **Access: Organizations, Identity Providers, and Groups — Edit**, and zone permission **DNS — Edit** for `nickly.me`. Wrangler OAuth handles Pages deployment; the additional token handles Access and DNS. Do not commit credentials.

```sh
wrangler login
pnpm cloudflare:setup    # Access, resumable migrations, builds, both Pages deployments
```

Individual steps:

```sh
pnpm cloudflare:access  # Configure email-code Access; write ignored local audience/domain
pnpm deploy:website    # Build, stage R2 image routes, deploy website, connect custom domain
pnpm deploy:admin      # Build and deploy admin; requires the configured Access settings
pnpm deploy:pages      # Deploy both projects
node scripts/pages-domain.mjs  # Connect domains for already-deployed projects
```

An existing DNS record pointing elsewhere stops domain setup without replacing it. Domain activation requires the correct CNAME and certificate issuance; uploading a Pages deployment alone does not confirm that its custom domain is live. Deployment status must be verified before claiming completion.

Tracked `wrangler.pages.jsonc` files describe each project. The deploy helper writes a standard `wrangler.jsonc` inside ignored `.pages-project/` staging directories because Wrangler Pages does not support custom configuration paths. The original admin Worker configuration remains for local development. Production authentication metadata is kept in ignored `apps/admin-dashboard/access.production.local.json`; no authentication tokens are placed in deployment output.

Set `PUBLIC_GALLERY_API_URL` only when using a different gallery service. Production defaults to `https://mmb.nickly.me`; development defaults to the local API. Canonical links use the configured Astro site. Original copy apart from the requested edits and all previous design changes remain under `apps/website/`.

### Migration safeguards

To migrate with an R2 S3 access key pair instead of Wrangler, copy `.env.example` to the ignored root `.env`, fill in `ACCESS_KEY_ID`, `ACCESS_KEY_SECRET`, and your bucket's `R2_ENDPOINT`, then run `pnpm gallery:migrate`. The migration automatically loads this file without replacing existing terminal variables. S3 credentials are used only by the Node migration script, never sent to either browser app. They cannot configure Cloudflare Access, DNS, or deploy Workers; those operations still require separate Cloudflare authentication. For setup credentials stored in `.env`, run `node --env-file=.env scripts/cloudflare-setup.mjs`.

The S3 migration checks access to the existing bucket before uploading and uses an atomic create-only catalog write so a concurrent administrator's catalog cannot be overwritten. Both S3 and Wrangler modes require network/DNS access to their respective Cloudflare endpoints.

`pnpm images:migrate` uses the same S3 credentials to upload all 937 original website images to `mmb-media/original/`, preserving their filenames and content types. Four uploads run concurrently, and a separate ignored checkpoint records each file's SHA-256 so interrupted runs resume without repeating completed uploads. This command uploads files only; it does not deploy the website or change its live image URLs.

`pnpm gallery:migrate` uploads immutable checksum-addressed image objects and then initializes `gallery/v1/catalog.json`. Existing YouTube videos remain embedded at their original URLs, with their original titles and timing notes. Upload progress is checkpointed in an ignored file. If a catalog already exists, migration stops without overwriting administrator changes. Initial remote seeding should run before the first Worker deployment; later changes belong in the dashboard.

R2 catalog edits use conditional ETag writes to preserve concurrent changes. Same-item edits use `updatedAt` preconditions and return a conflict instead of silently overwriting another admin. Removing an item only deletes media objects no longer referenced by another item. Interrupted multipart uploads can be canceled; configure R2's incomplete-multipart lifecycle cleanup as an additional housekeeping measure.

The contact form retains its original Weebly processor/reCAPTCHA configuration; it is unrelated to gallery administration. See `apps/website/README.md` for the original capture and content-update workflow.
