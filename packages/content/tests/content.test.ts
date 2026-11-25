import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAGE_SLUGS,
  extractDriveFolderId,
  renderPageHtml,
  renderStructuredDataJsonLd,
  validatePageInput,
  validateStoredPageDocument,
  type DriveFolderCache,
  type PageDocument,
} from '../src/index';
import { extractSeedPages } from '../src/seed';

describe('@mmb/content schema, validation, and rendering', () => {
  it('extracts Drive folder IDs from URLs and rejects unrelated hosts', () => {
    expect(extractDriveFolderId('https://drive.google.com/drive/folders/1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA?usp=sharing')).toBe('1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA');
    expect(extractDriveFolderId('https://drive.google.com/drive/u/1/folders/abcDEF123456_789')).toBe('abcDEF123456_789');
    expect(extractDriveFolderId('https://drive.google.com/open?id=abcDEF123456_789')).toBe('abcDEF123456_789');
    expect(extractDriveFolderId('abcDEF123456_789')).toBe('abcDEF123456_789');
    expect(extractDriveFolderId('https://evil.example/drive/folders/abcDEF123456_789')).toBeNull();
  });

  it('rejects unsafe URLs and invalid asset keys', () => {
    expect(() =>
      validatePageInput('faq', {
        seo: { title: 'FAQ', description: 'Desc' },
        blocks: [
          {
            id: 'b1',
            type: 'button-bar',
            buttons: [{ id: 'btn1', label: 'Bad', href: 'javascript:alert(1)' }],
          },
        ],
      })
    ).toThrow(/https:\/\/, mailto:/);

    expect(() =>
      validatePageInput('our-team', {
        seo: { title: 'Team', description: 'Desc' },
        blocks: [
          {
            id: 'b1',
            type: 'image',
            image: { assetKey: 'content/assets/../../etc/passwd', alt: 'bad' },
          },
        ],
      })
    ).toThrow(/invalid uploaded image key/);
  });

  it('escapes HTML and </script> sequences in rendered HTML and JSON-LD', () => {
    const doc: PageDocument = {
      schemaVersion: 1,
      slug: 'faq',
      revision: 1,
      updatedAt: '2026-11-24T00:00:00.000Z',
      updatedBy: 'admin@mmb.test',
      seo: { title: 'FAQ <script>', description: 'Test "desc"' },
      blocks: [
        {
          id: 'faq1',
          type: 'faq-group',
          anchor: 'students',
          buttonLabel: 'Students',
          heading: 'Students <img onerror=alert(1)>',
          items: [
            {
              id: 'q1',
              question: 'Is </script> safe?',
              answer: [
                {
                  type: 'paragraph',
                  children: [
                    { type: 'text', text: '<script>alert(1)</script> ', bold: true },
                    { type: 'link', text: 'Contact', href: '/contact.html' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const html = renderPageHtml(doc);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="/contact"');
    expect(html).not.toContain('href="/contact.html"');

    const jsonLd = renderStructuredDataJsonLd(doc);
    expect(jsonLd).toBeTruthy();
    expect(jsonLd).not.toContain('</script>');
    expect(jsonLd).toContain('\\u003c/script>');
  });

  it('renders Google Drive meeting minutes grouped by subfolder', () => {
    const doc: PageDocument = {
      schemaVersion: 1,
      slug: 'executive-meeting-minutes',
      revision: 2,
      updatedAt: '2026-11-24T00:00:00.000Z',
      updatedBy: 'admin@mmb.test',
      seo: { title: 'Minutes', description: 'Minutes' },
      blocks: [
        {
          id: 'drive1',
          type: 'drive-minutes',
          heading: 'Executive Meeting Minutes',
          folderUrl: 'https://drive.google.com/drive/folders/1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA',
          folderId: '1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA',
          groupBySubfolder: true,
          sortOrder: 'name-desc',
          showDates: true,
        },
      ],
    };
    const cache: DriveFolderCache = {
      folderId: '1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA',
      syncedAt: '2026-11-24T12:00:00.000Z',
      rootFiles: [],
      subfolders: [
        {
          id: 'sub1',
          name: '2025-2026',
          files: [
            {
              id: 'file1',
              name: '2025-10-14 Exec Minutes.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2025-10-15T10:00:00.000Z',
              size: 102400,
              webViewLink: 'https://drive.google.com/file/d/file1/view',
            },
          ],
        },
      ],
    };

    const html = renderPageHtml(doc, { driveCaches: { [cache.folderId]: cache } });
    expect(html).toContain('2025-2026');
    expect(html).toContain('2025-10-14 Exec Minutes.pdf');
    expect(html).toContain('https://drive.google.com/file/d/file1/view');
  });

  it('extracts valid seed documents for all 5 editable pages from prepared-site.json', () => {
    const websiteDir = path.resolve(import.meta.dirname, '../../../apps/website/src/data');
    const preparedSite = JSON.parse(readFileSync(path.join(websiteDir, 'prepared-site.json'), 'utf8'));
    const images = JSON.parse(readFileSync(path.join(websiteDir, 'images.json'), 'utf8'));
    const seeded = extractSeedPages(preparedSite, images, '2026-11-24T00:00:00.000Z');

    for (const slug of PAGE_SLUGS) {
      const doc = validateStoredPageDocument(seeded[slug]);
      expect(doc.blocks.length).toBeGreaterThan(0);
      const html = renderPageHtml(doc);
      expect(html.length).toBeGreaterThan(100);
    }

    expect(seeded.faq.blocks.some(b => b.type === 'faq-group' && b.items.length === 6)).toBe(true);
    expect(seeded['our-team'].blocks.some(b => b.type === 'team-group' && b.layout === 'executives' && b.members.length === 9)).toBe(true);
    expect(seeded['our-team'].blocks.some(b => b.type === 'team-group' && b.layout === 'leaders' && b.members.length === 4 && b.members.every(m => !('status' in m)))).toBe(true);
    expect(seeded.budget.blocks.filter(b => b.type === 'document-list')).toHaveLength(13);
    expect(seeded.constitution.blocks.filter(b => b.type === 'document-list')).toHaveLength(2);
    expect(seeded['executive-meeting-minutes'].blocks.some(b => b.type === 'drive-minutes' && b.folderId === '1_5ueL5hj6w3SNRasgjQZLyDqu044NoUA')).toBe(true);
    expect(seeded['executive-meeting-minutes'].blocks.some(b => b.type === 'sponsor-grid' && b.sponsors.length === 2)).toBe(true);
  });

  it('validates legacy stored our-team JSON with status "tba" or "active", strips status, and renders normally', () => {
    const legacyDoc = {
      schemaVersion: 1,
      slug: 'our-team',
      revision: 3,
      updatedAt: '2026-11-24T00:00:00.000Z',
      updatedBy: 'admin@mmb.test',
      seo: { title: 'Our Team - MMB', description: 'Team' },
      blocks: [
        {
          id: 'team-leaders',
          type: 'team-group',
          heading: 'Section Leaders',
          layout: 'leaders',
          background: 'gray',
          members: [
            {
              id: 'leader-1',
              name: 'Guard lead',
              pronouns: '(they/them)',
              role: 'Color Guard Section Leader',
              program: 'Music II',
              bio: [{ type: 'paragraph', children: [{ type: 'text', text: 'Leads the guard section.' }] }],
              status: 'tba',
            },
            {
              id: 'leader-2',
              name: 'Samuel Zhao',
              role: 'Brass lead',
              bio: [],
              status: 'active',
            },
            {
              id: 'leader-3',
              name: 'Cole',
              role: 'Winds lead',
              bio: [],
            },
          ],
        },
      ],
    };

    const validated = validateStoredPageDocument(legacyDoc);
    const group = validated.blocks[0];
    expect(group.type).toBe('team-group');
    if (group.type !== 'team-group') throw new Error('Expected team-group');

    expect(group.members).toHaveLength(3);
    for (const member of group.members) {
      expect('status' in member).toBe(false);
    }

    const html = renderPageHtml(validated);
    expect(html).toContain('Guard lead');
    expect(html).toContain('(they/them)');
    expect(html).toContain('Color Guard Section Leader');
    expect(html).toContain('Music II');
    expect(html).toContain('Leads the guard section.');
    expect(html).not.toContain('To be announced');
    expect(html).toContain('Samuel Zhao');
    expect(html).toContain('Cole');
  });
});
