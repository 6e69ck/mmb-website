import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { MockR2 } from './mock-r2';

const ORIGIN = 'http://localhost:8787';
const MEDIA_ORIGIN = 'https://media.mmb.nickly.me';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
const XLSX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

type Env = Record<string, unknown> & { MEDIA: MockR2 };
let env: Env;
const context = { waitUntil() {}, passThroughOnException() {} };

function request(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; origin?: string; host?: string; raw?: boolean } = {}
) {
  const method = options.method || 'GET';
  const headers: Record<string, string> = {
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { 'Content-Type': options.raw ? 'application/octet-stream' : 'application/json', 'X-Requested-With': 'MMB-Gallery' }),
    Origin: options.origin || ORIGIN,
    ...options.headers,
  };
  const body = options.body === undefined ? undefined : options.raw ? (options.body as BodyInit) : JSON.stringify(options.body);
  const req = new Request(new URL(path, options.host || ORIGIN), { method, headers, body });
  return (worker as unknown as { fetch(req: Request, env: Env, context: unknown): Promise<Response> }).fetch(req, env, context);
}

async function json(path: string, method = 'GET', body?: unknown) {
  const response = await request(path, { method, body });
  const data = (await response.json()) as Record<string, any>;
  return { response, data };
}

beforeEach(() => {
  env = {
    ENVIRONMENT: 'development',
    DEV_AUTH: 'true',
    ADMIN_EMAILS: 'nickly88@pm.me',
    PUBLIC_MEDIA_ORIGIN: MEDIA_ORIGIN,
    ADMIN_ORIGIN: ORIGIN,
    MEDIA: new MockR2(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin page editing, assets, GitHub history, and Drive sync', () => {
  it('enforces auth and CSRF boundaries for admin page endpoints', async () => {
    env.ENVIRONMENT = 'production';
    expect((await request('/api/admin/pages')).status).toBeGreaterThanOrEqual(400);
    expect(
      (await request('/api/admin/pages/faq', { method: 'PUT', body: { seo: { title: 'FAQ', description: '' }, blocks: [] } })).status
    ).toBeGreaterThanOrEqual(400);

    env.ENVIRONMENT = 'development';
    const crossOrigin = await request('/api/admin/pages/faq', {
      method: 'PUT',
      origin: 'https://evil.example',
      body: { seo: { title: 'FAQ', description: '' }, blocks: [] },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('validates content asset magic bytes and restricts unreferenced /files/* on public origins', async () => {
    const fakePdf = await request('/api/admin/content/assets', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'fake.pdf' },
      body: new TextEncoder().encode('NOT_A_PDF'),
    });
    expect(fakePdf.status).toBe(400);

    const validPdf = await request('/api/admin/content/assets', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/pdf', 'X-Filename': 'constitution.pdf' },
      body: PDF,
    });
    expect(validPdf.status).toBe(201);
    const pdfData = (await validPdf.json()) as { assetKey: string; url: string };
    expect(pdfData.url).toMatch(/^\/files\/[0-9a-f-]+\/constitution\.pdf$/);

    // Unreferenced file is hidden on public media origin
    const unreferencedPublic = await request(pdfData.url, { host: MEDIA_ORIGIN });
    expect(unreferencedPublic.status).toBe(404);

    // Upload XLSX and reference both in constitution page
    const validXlsx = await request('/api/admin/content/assets', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-Filename': 'budget.xlsx' },
      body: XLSX,
    });
    expect(validXlsx.status).toBe(201);
    const xlsxData = (await validXlsx.json()) as { assetKey: string; url: string };

    const saved = await json('/api/admin/pages/constitution', 'PUT', {
      expectedRevision: 0,
      seo: { title: 'Constitution - MMB', description: 'Docs' },
      blocks: [
        {
          id: 'docs1',
          type: 'document-list',
          heading: 'Documents',
          documents: [
            { id: 'd1', label: 'Constitution', filename: 'constitution.pdf', assetKey: pdfData.assetKey, fileType: 'pdf' },
            { id: 'd2', label: 'Budget', filename: 'budget.xlsx', assetKey: xlsxData.assetKey, fileType: 'xlsx' },
          ],
        },
      ],
    });
    expect(saved.response.status).toBe(200);

    const servedPdf = await request(pdfData.url, { host: MEDIA_ORIGIN });
    expect(servedPdf.status).toBe(200);
    expect(servedPdf.headers.get('Content-Disposition')).toBe('inline');
    expect(servedPdf.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const servedXlsx = await request(xlsxData.url, { host: MEDIA_ORIGIN });
    expect(servedXlsx.status).toBe(200);
    expect(servedXlsx.headers.get('Content-Disposition')).toContain('attachment');

    const publicApi = await json('/api/content/constitution');
    expect(publicApi.response.status).toBe(200);
    expect(publicApi.data.page.revision).toBe(1);
  });

  it('prevents concurrent overwrites with 409 and supports non-destructive R2 rollback', async () => {
    const first = await json('/api/admin/pages/faq', 'PUT', {
      expectedRevision: 0,
      commitMessage: 'First version',
      seo: { title: 'FAQ v1', description: 'v1' },
      blocks: [{ id: 'h1', type: 'heading', text: 'First Heading', align: 'center' }],
    });
    expect(first.response.status).toBe(200);
    expect(first.data.page.revision).toBe(1);

    const second = await json('/api/admin/pages/faq', 'PUT', {
      expectedRevision: 1,
      commitMessage: 'Second version',
      seo: { title: 'FAQ v2', description: 'v2' },
      blocks: [{ id: 'h1', type: 'heading', text: 'Second Heading', align: 'left' }],
    });
    expect(second.response.status).toBe(200);
    expect(second.data.page.revision).toBe(2);

    const conflict = await json('/api/admin/pages/faq', 'PUT', {
      expectedRevision: 1,
      seo: { title: 'Stale', description: 'stale' },
      blocks: [],
    });
    expect(conflict.response.status).toBe(409);

    const history = await json('/api/admin/pages/faq/history');
    expect(history.response.status).toBe(200);
    expect(history.data.versions).toHaveLength(2);
    expect(history.data.versions[0].versionId).toBe('rev-2');

    const restored = await json('/api/admin/pages/faq/rollback', 'POST', {
      versionId: 'rev-1',
      expectedRevision: 2,
    });
    expect(restored.response.status).toBe(200);
    expect(restored.data.page.revision).toBe(3);
    expect(restored.data.page.seo.title).toBe('FAQ v1');
    expect(restored.data.page.blocks[0].text).toBe('First Heading');
  });

  it('commits page JSON to GitHub content repo and reads GitHub commit history when configured', async () => {
    env.CONTENT_GITHUB_REPO = 'mmb/content-repo';
    env.CONTENT_GITHUB_BRANCH = 'main';
    env.CONTENT_GITHUB_TOKEN = 'ghp_test_token';

    const storedV1 = {
      schemaVersion: 1,
      slug: 'budget',
      revision: 1,
      commitMessage: 'Initial budget',
      updatedAt: '2026-11-24T01:00:00.000Z',
      updatedBy: 'nickly88@pm.me',
      seo: { title: 'Budget - MMB', description: 'Budgets' },
      blocks: [{ id: 'b1', type: 'heading', text: '2025-2026', align: 'left' }],
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method || 'GET';
      if (url.includes('/contents/pages/budget.json') && method === 'GET' && !url.includes('ref=abc1234')) {
        return new Response(JSON.stringify({ sha: 'file_sha_1' }), { status: 200 });
      }
      if (url.includes('/contents/pages/budget.json') && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        expect(body.sha).toBe('file_sha_1');
        expect(body.author.email).toBe('nickly88@pm.me');
        return new Response(JSON.stringify({ commit: { sha: 'commit_sha_2' }, content: { sha: 'file_sha_2' } }), { status: 200 });
      }
      if (url.includes('/commits?path=pages%2Fbudget.json')) {
        return new Response(
          JSON.stringify([
            {
              sha: 'abc1234567890',
              commit: { message: 'Initial budget', author: { email: 'nickly88@pm.me', date: '2026-11-24T01:00:00.000Z' } },
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/contents/pages%2Fbudget.json?ref=abc1234567890')) {
        const b64 = Buffer.from(JSON.stringify(storedV1), 'utf8').toString('base64');
        return new Response(JSON.stringify({ encoding: 'base64', content: b64 }), { status: 200 });
      }
      return new Response('Unexpected fetch', { status: 500 });
    });

    const saved = await json('/api/admin/pages/budget', 'PUT', {
      expectedRevision: 0,
      commitMessage: 'Publish budget',
      seo: { title: 'Budget - MMB', description: 'Budgets' },
      blocks: [{ id: 'b1', type: 'heading', text: '2026-2027', align: 'left' }],
    });
    expect(saved.response.status).toBe(200);
    expect(saved.data.page.gitSha).toBe('file_sha_2');

    const history = await json('/api/admin/pages/budget/history');
    expect(history.response.status).toBe(200);
    expect(history.data.provider).toBe('github');
    expect(history.data.versions[0].versionId).toBe('abc1234567890');

    const preview = await json('/api/admin/pages/budget/history/abc1234567890');
    expect(preview.response.status).toBe(200);
    expect(preview.data.page.blocks[0].text).toBe('2025-2026');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('syncs Google Drive meeting minutes folder and caches subfolders in R2', async () => {
    env.GOOGLE_DRIVE_API_KEY = 'fake-drive-key';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('rootFolder123456')) {
        return new Response(
          JSON.stringify({
            files: [
              { id: 'subFolder2025', name: '2025-2026', mimeType: 'application/vnd.google-apps.folder' },
              { id: 'rootFile1', name: 'Overview.pdf', mimeType: 'application/pdf', modifiedTime: '2026-01-01T00:00:00Z', size: '2048', webViewLink: 'https://drive.google.com/file/d/rootFile1/view' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('subFolder2025')) {
        return new Response(
          JSON.stringify({
            files: [
              { id: 'minFile1', name: 'Sept 2025 Minutes.pdf', mimeType: 'application/pdf', modifiedTime: '2025-09-10T00:00:00Z', size: '4096', webViewLink: 'https://drive.google.com/file/d/minFile1/view' },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const synced = await json('/api/admin/drive/sync', 'POST', {
      folderUrl: 'https://drive.google.com/drive/folders/rootFolder123456',
    });
    expect(synced.response.status).toBe(200);
    expect(synced.data.cache.rootFiles).toHaveLength(1);
    expect(synced.data.cache.subfolders).toHaveLength(1);
    expect(synced.data.cache.subfolders[0].files[0].name).toBe('Sept 2025 Minutes.pdf');
    expect(PNG.length).toBeGreaterThan(0);
  });
});
