import { chromium } from '@playwright/test';
import chromiumBinary from '@sparticuz/chromium';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: await chromiumBinary.executablePath(), args: chromiumBinary.args, headless: true });
await mkdir('/tmp/mmb-qa', { recursive: true });
const siteOrigin = process.env.WEBSITE_PREVIEW_URL || "http://127.0.0.1:4323";
const mediaOrigin = process.env.GALLERY_API_URL || "http://127.0.0.1:8787";
const errors = [];
const results = [];
const focusedTeam = process.argv.includes('--team');
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.route("**/*", route => [new URL(siteOrigin).origin, new URL(mediaOrigin).origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  for (const width of focusedTeam ? [320, 1440] : [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of focusedTeam ? ['/our-team.html'] : ['/', '/join.html', '/our-team.html', '/faq.html', '/gallery.html', '/mmbs-2025.html', '/contact.html', '/budget.html']) {
      const response = await page.goto(`${siteOrigin}${path}`, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200, `${path} response`);
      await page.waitForSelector('astro-island[component-export="default"]:not([ssr])');
      const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(overflow.scroll <= overflow.width + 1, `${width} ${path} horizontal overflow: ${JSON.stringify(overflow)}`);
      await page.locator('.site-brand img[data-image-ready="true"]').waitFor();
      if (path === '/contact.html') {
        const boxes = await page.locator('form').first().evaluate(form => {
          const rect = el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right }; };
          return {
            first: rect(form.querySelector('.wsite-form-input-first-name input')),
            last: rect(form.querySelector('.wsite-form-input-last-name input')),
            email: rect(form.querySelector('input[type="email"]')),
            message: rect(form.querySelector('textarea')),
          };
        });
        assert.ok(Math.abs(boxes.first.left - boxes.email.left) < 1, `${width} ${path}: name/email left edges`);
        assert.ok(Math.abs(boxes.last.right - boxes.email.right) < 1, `${width} ${path}: name/email right edges`);
        assert.ok(Math.abs(boxes.message.left - boxes.email.left) < 1 && Math.abs(boxes.message.right - boxes.email.right) < 1, `${width} ${path}: message/email edges`);
      }
      if (path === '/join.html') {
          assert.equal(await page.locator('#wsite-content form').count(), 0, 'Join must use the Google Form instead of an embedded form');
          const googleForm = page.locator('a.join-google-form-button');
          assert.equal(await googleForm.getAttribute('href'), 'https://forms.gle/DadBMUj3s5rWDKuN9');
          assert.equal(await googleForm.count(), 1);
          const venue = page.locator('.join-rehearsal-venue');
          assert.equal(await venue.textContent(), 'Fitzhenry Studio @ David Braley Athletic Centre (DBAC)');
          assert.equal(await venue.evaluate(el => getComputedStyle(el).fontWeight), '700');
          assert.equal(await venue.evaluate(el => getComputedStyle(el).color), 'rgb(122, 0, 60)');
          assert.deepEqual(await page.locator('.join-ensemble-card h2').allTextContents(), ['Brass', 'Woodwinds', 'Drumline', 'Colour Guard']);
          assert.ok((await page.locator('.join-ensemble').textContent()).includes('hornline (brass, woodwinds)'));
          const discord = page.getByRole('link', { name: 'Join the Discord server' });
          assert.equal(await discord.getAttribute('href'), 'https://discord.com/invite/nV6faA6cbR');
          assert.equal(await discord.locator('svg').count(), 1);
          assert.deepEqual((await page.locator('.join-action-row > a').allTextContents()).map(text => text.trim()), ['Fill out the form!', 'Join the Discord server']);
          if (width >= 768) {
            const googleBox = await googleForm.boundingBox(), discordBox = await discord.boundingBox();
            assert.ok(googleBox.x < discordBox.x && Math.abs(googleBox.y - discordBox.y) < 1, 'Google Form should be immediately left of Discord');
          }
          for (const card of await page.locator('.join-ensemble-card').all()) assert.equal(await card.locator('img').count(), 1, 'Each ensemble card needs its own image');
          const columns = await page.locator('.join-ensemble-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
          assert.equal(columns, width <= 767 ? 1 : 2, 'All ensemble sections must share the responsive grid');
          if (width >= 768 && width <= 1050) {
            const gridBox = await page.locator('.join-ensemble-grid').boundingBox();
            assert.ok(gridBox.width > width * .75, 'Tablet ensemble grid should use the full page column');
          }
          await page.screenshot({ path: `/tmp/mmb-qa/join-${width}.png`, fullPage: true, animations: 'disabled' });
      }
      if (path === '/') await page.screenshot({ path: `/tmp/mmb-qa/home-${width}.png`, fullPage: true });
      if (path === '/our-team.html') {
        const names = await page.locator('.team-executive-members h2').allTextContents();
        assert.equal(names.length, 5, 'Samara through Mia must share one section');
        for (const [index, name] of ['Samara', 'Norah', 'Alaine', 'Oie', 'Mia'].entries()) assert.ok(names[index].includes(name));
        assert.deepEqual(await page.locator('.team-leader-profile h2').allTextContents(), ['Samuel Zhao', 'Cole', 'Liam Henderson', 'Guard lead']);
        assert.deepEqual(await page.locator('.team-leader-profile .team-placeholder-status').allTextContents(), ['Brass lead', 'Winds lead', 'Drumline lead', 'To be announced']);
        const styles = await page.locator('.team-leader-profile').first().evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth }));
        assert.equal(styles.background, 'rgba(0, 0, 0, 0)', 'Leader profiles should use an open layout');
        assert.equal(styles.border, '0px', 'Leader profiles should not have card borders');
        const leaderPositions = await page.locator('.team-leader-profile').evaluateAll(elements => elements.map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })));
        assert.ok(Math.abs(leaderPositions[0].y - leaderPositions[1].y) < 1 && Math.abs(leaderPositions[2].y - leaderPositions[3].y) < 1, 'Section Leaders must stay in two rows of two');
        assert.ok(leaderPositions[1].x > leaderPositions[0].x && Math.abs(leaderPositions[0].x - leaderPositions[2].x) < 1, 'Section Leaders must stay in two columns');
        await page.locator('.team-leaders').screenshot({ path: `/tmp/mmb-qa/section-leaders-${width}.png`, animations: 'disabled' });
        await page.locator('.team-executive-members').screenshot({ path: `/tmp/mmb-qa/executive-members-${width}.png`, animations: 'disabled' });
      }
      if (path === '/faq.html') {
        assert.deepEqual(await page.locator('.faq-audience-button').allTextContents(), ['Students', 'Organizers']);
        for (const button of await page.locator('.faq-audience-button').all()) {
          const box = await button.boundingBox();
          assert.ok(box.height >= 60, 'FAQ audience buttons should be prominent touch targets');
          assert.equal(await button.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(122, 0, 60)');
        }
        await page.getByRole('link', { name: 'Organizers', exact: true }).click();
        assert.ok(page.url().endsWith('#organizers'));
      }
      if (path === '/mmbs-2025.html') {
        await page.screenshot({ path: `/tmp/mmb-qa/gallery-${width}.png`, fullPage: true });
        await page.locator('a[rel^="lightbox"] img').first().click();
        await page.locator('dialog[open]').waitFor();
        await page.keyboard.press('ArrowRight');
        assert.match(await page.locator('.photo-count').innerText(), /^2\s*\//);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('dialog[open]').count(), 0);
      }
      if (path === '/gallery.html') {
        const selector = page.getByRole('combobox', { name: 'Select gallery year' });
        assert.equal(await selector.inputValue(), '2025');
        assert.ok(await page.getByRole('button', { name: 'Next year', exact: true }).isDisabled());
        await page.getByRole('button', { name: 'Previous year', exact: true }).click();
        await page.locator('.gallery-mosaic[aria-busy="false"] .mosaic-tile').first().waitFor();
        assert.equal(await selector.inputValue(), '2024');
        await page.locator('.mosaic-tile img[data-image-ready="true"]').first().waitFor();
        await selector.selectOption('2009');
        await page.locator('.gallery-mosaic[aria-busy="false"] .mosaic-tile').first().waitFor();
        assert.ok(await page.getByRole('button', { name: 'Previous year', exact: true }).isDisabled());
        await page.goBack({ waitUntil: 'networkidle' });
        assert.equal(await selector.inputValue(), '2024');
        await selector.selectOption('2025');
        await page.locator('.gallery-mosaic[aria-busy="false"] .mosaic-tile').first().waitFor();
        await page.locator('.mosaic-tile img[data-image-ready="true"]').first().waitFor();
        await page.screenshot({ path: `/tmp/mmb-qa/mosaic-${width}.png` });
        await page.getByRole('button', { name: 'Videos', exact: true }).click();
        await page.locator('.gallery-mosaic[aria-busy="false"] .mosaic-video iframe').first().waitFor();
        assert.equal(await selector.inputValue(), '2019', 'Videos filter should open the newest available video year');
        assert.equal(await page.locator('.gallery-mosaic img').count(), 0);
        await page.getByRole('button', { name: 'All media', exact: true }).click();
        await selector.selectOption('2017');
        await page.locator('.gallery-mosaic[aria-busy="false"] .mosaic-video iframe').first().waitFor();
        assert.ok(await page.locator('.gallery-mosaic img').count() > 0, 'Mixed gallery must contain photos and videos');
        assert.equal(await page.locator('.mosaic-video figcaption').first().evaluate(el => getComputedStyle(el).opacity), '1');
        await page.getByRole('button', { name: 'Photos', exact: true }).click();
        assert.equal(await page.locator('.gallery-mosaic iframe').count(), 0);
        await page.goBack({ waitUntil: 'networkidle' });
        await page.locator('.gallery-mosaic iframe').first().waitFor();
      }
      assert.match(await page.locator('.site-footer-bottom p').textContent(), /2026/);
      results.push({ width, path, status: 'passed' });
    }
    await page.goto(siteOrigin + '/', { waitUntil: 'networkidle' });
    if (width <= 1240) await page.locator('.menu-toggle').click();
    const navOrder = await page.locator('.site-menu > li > .site-menu-link > a').allTextContents();
    assert.equal(navOrder[navOrder.indexOf('Our Team') + 1], 'Alumni', 'Alumni should immediately follow Our Team');
    assert.equal(navOrder[navOrder.indexOf('Alumni') + 1], 'Media', 'Media should immediately follow Alumni');
    assert.equal(navOrder[navOrder.indexOf('Media') + 1], 'Events', 'Events should follow Media');
    const media = page.locator('.site-menu > li').filter({ has: page.locator('a[href="/gallery.html"]') });
    assert.equal(await media.locator('details').count(), 0, 'Media should link directly to the gallery');
    assert.ok(await page.locator('.site-join-button').isVisible());
    if (width <= 1240) {
      const mediaLink = media.locator('a');
      const box = await mediaLink.boundingBox();
      const row = await media.boundingBox();
      assert.ok(box.width >= row.width - 2 && box.height >= 48, 'Entire mobile Media row should be clickable');
      await mediaLink.click({ position: { x: box.width - 12, y: box.height / 2 } });
      await page.waitForLoadState('networkidle');
      await page.locator('astro-island:has(.site-header):not([ssr])').waitFor();
      assert.ok(page.url().endsWith('/gallery.html'));
      if (!await page.locator('.site-navigation').evaluate(el => el.open)) await page.locator('.menu-toggle').click();
    } else {
      const events = page.locator('.site-menu > li').filter({ has: page.locator('a[href="/about.html"]') });
      await events.locator('a[href="/about.html"]').hover();
      await page.waitForFunction(() => document.querySelector('.site-menu a[href="/about.html"]').closest('li').querySelector('details').open);
      assert.ok(await events.locator('a[href="/events.html"]').isVisible(), 'Hover alone should open the Events dropdown');
      await page.keyboard.press('Escape');
    }
    await page.locator('.more-disclosure > summary').click();
    assert.ok(await page.locator('.site-menu a[href="/budget.html"]').isVisible());
    if (width > 1240) {
      const alignment = await page.locator('.more-disclosure').evaluate(el => ({ button: el.querySelector('summary').getBoundingClientRect().left, dropdown: el.querySelector('.site-submenu').getBoundingClientRect().left }));
      assert.ok(Math.abs(alignment.button - alignment.dropdown) < 1, 'Dropdown must align to the left edge of its button');
    }
  }
  assert.deepEqual(errors, [], 'client errors');
  await writeFile('/tmp/mmb-qa/results.json', JSON.stringify(results, null, 2));
  console.log(focusedTeam
    ? `Browser QA passed: team grouping, open Section Leader profiles, Alumni order, menus and local images at 320px and 1440px; no horizontal overflow or client errors.`
    : `Browser QA passed: ${results.length} page/viewport checks, mobile and desktop menus, gallery navigation and Escape, local image loading, no horizontal overflow or client errors.`);
} finally { await browser.close(); }
