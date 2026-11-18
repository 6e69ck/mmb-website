# McMaster Marching Band

An Astro static rebuild of https://www.mcmastermarchingband.com with React islands for navigation, progressive images, the year-selectable photo/video mosaic, the photo viewer, and the contact form.

## Development

```sh
pnpm install
pnpm dev
```

Astro prints the local URL and watches for changes with HMR. If port 4321 is occupied it selects another port. Use `pnpm dev status` to check the running server.

```sh
pnpm check
pnpm build
pnpm verify
```

`pnpm build` generates all 26 pages and checks preserved copy against the original HTML plus explicit content updates. It also verifies local links, image placeholders, contact form fields, the 2026 footer, and preservation of every gallery photo, video, caption, and timing note. The build uses local captures and works offline after dependencies are installed.

## Content preservation

- `source-site/*.html` contains the original, unedited page captures.
- `src/data/site.json` contains the original content extracted without rewriting it.
- `public/original/` contains the original images, fonts, styles, and documents.
- `source-site/asset-manifest.json` maps original asset URLs to local files.
- `src/data/images.json` contains a BlurHash, original dimensions, and a decoded PNG placeholder for every raster image asset.
- `scripts/prepare-images.mjs` adds progressive loading without changing text.
- `src/content/join-updates.mjs` records the Brass/Woodwinds cards, hornline terminology, rehearsal guidance, maroon venue, Google Form signup, and Discord invitation. The original capture stays intact.
- `src/content/team-updates.mjs` groups the original profiles under Executives and adds the supplied Section Leaders in an open 2×2 layout at every screen width.
- `src/content/faq-updates.mjs` turns the two audience navigation links into prominent Students/Organizers buttons.
- `scripts/prepare-gallery.mjs` combines 372 distinct photos and 12 original videos, with captions and timing notes, across 12 years. Checksums remove duplicate image bytes; `/gallery.html` opens the newest album, old annual/media/video URLs still work, and year/type controls support browser history and shareable URLs.

The requested homepage heading, ensemble/team sections, gallery navigation, and compact 2026 footer are explicit content/design updates. All unrelated source copy remains unchanged.

All original `.html` page URLs remain available. The navigation groups Budget, Constitution, and Executive Meeting Minutes under “More...”. The Join the band link uses CSS uppercase styling and a square maroon button.

To deliberately update the capture from the original website:

```sh
pnpm capture --refresh
pnpm build
```

This updates the captured content and assets to the source website's current state, so review changes before publishing. Image cache entries include a checksum; changed image bytes automatically regenerate their BlurHashes.

## Images and interaction

Images begin with PNGs decoded from their BlurHashes and reserve their original dimensions. React preloads and decodes nearby images before revealing them. Background images crossfade from their placeholders. Native `<picture>` sources provide full images when JavaScript is disabled.

The photo viewer supports previous/next controls, arrow keys, Escape, focus return, and native dialog focus containment. Desktop dropdowns open after 200ms hover and close after 180ms; native disclosure elements retain keyboard/touch support. Mobile navigation rows provide full-width touch targets. Media links directly to the combined gallery. Reduced-motion preferences are honored.

## Forms and embeds

The embedded join form was removed: signup uses the original Google Form button, alongside the requested Discord invitation. The contact form retains its original fields, processor URL, and invisible reCAPTCHA site key. Its React island loads reCAPTCHA on submission. That key is controlled by the existing Weebly site and may require the preview/new domain to be allowed. Actual submissions were not sent during verification. The calendar, original videos, and external links retain their destinations.

## Browser verification

With the development server running on `http://localhost:4323`:

```sh
pnpm test:browser
```

This checks representative pages at 320, 768, 1024, and 1440 pixels: desktop hover menus, full-width mobile links, combined gallery filters/history, photo viewer controls, FAQ buttons, contact field alignment, Google/Discord links, and the 2×2 leader layout. Screenshots/results are written to `/tmp/mmb-qa/`. `pnpm build --qa` runs the build, preservation checks, and browser checks together.

## Deployment

The static output is `dist/`. `.openai/hosting.json` identifies the separate Sites preview copy. No DNS or settings on the team's original domain were changed.
