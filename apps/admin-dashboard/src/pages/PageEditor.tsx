import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PAGE_METADATA,
  renderPageHtml,
  type DriveFolderCache,
  type PageBlock,
  type PageDocument,
  type PageSeo,
  type PageSlug,
} from '@mmb/content';
import websiteContentCss from '../../../website/src/styles/content-blocks.css?raw';
import websiteFaqCss from '../../../website/src/styles/faq-buttons.css?raw';
import websiteTeamCss from '../../../website/src/styles/team-sections.css?raw';
import { api, ApiError } from '../api';
import { Icon } from '../ui';
import { siteOriginFor } from './asset-urls';
import BlockComposer from './BlockComposer';
import FaqEditor from './FaqEditor';
import HistoryDrawer from './HistoryDrawer';
import TeamEditor from './TeamEditor';

type PageLoadResult = {
  page: PageDocument;
  seeded: boolean;
  driveCaches: Record<string, DriveFolderCache>;
  historyProvider: 'github' | 'r2';
  driveConfigured: boolean;
};

type ViewMode = 'edit' | 'rearrange' | 'split' | 'preview';

export default function PageEditor({
  slug,
  mode,
  onDirtyChange,
}: {
  slug: PageSlug;
  mode: 'local' | 'production';
  onDirtyChange: (dirty: boolean) => void;
}) {
  const meta = PAGE_METADATA[slug];
  const [serverPage, setServerPage] = useState<PageDocument | null>(null);
  const [seo, setSeo] = useState<PageSeo>({ title: meta.defaultTitle, description: meta.defaultDescription });
  const [blocks, setBlocks] = useState<PageBlock[]>([]);
  const [driveCaches, setDriveCaches] = useState<Record<string, DriveFolderCache>>({});
  const [historyProvider, setHistoryProvider] = useState<'github' | 'r2'>('r2');
  const [driveConfigured, setDriveConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('edit');
  const [seoOpen, setSeoOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api<PageLoadResult>(`/api/admin/pages/${slug}`);
      setServerPage(res.page);
      setSeo(res.page.seo);
      setBlocks(res.page.blocks);
      setDriveCaches(res.driveCaches || {});
      setHistoryProvider(res.historyProvider);
      setDriveConfigured(res.driveConfigured);
      setCommitMessage('');
      onDirtyChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load page.');
    } finally {
      setLoading(false);
    }
  }, [slug, onDirtyChange]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const isDirty = useMemo(() => {
    if (!serverPage) return false;
    return JSON.stringify({ seo, blocks }) !== JSON.stringify({ seo: serverPage.seo, blocks: serverPage.blocks });
  }, [serverPage, seo, blocks]);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const publish = async () => {
    if (!serverPage) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api<{ page: PageDocument; driveCaches: Record<string, DriveFolderCache> }>(`/api/admin/pages/${slug}`, {
        method: 'PUT',
        body: JSON.stringify({
          seo,
          blocks,
          commitMessage: commitMessage.trim() || undefined,
          expectedRevision: serverPage.revision,
          ...(serverPage.gitSha ? { expectedGitSha: serverPage.gitSha } : {}),
        }),
      });
      setServerPage(res.page);
      setSeo(res.page.seo);
      setBlocks(res.page.blocks);
      setDriveCaches(res.driveCaches || {});
      setCommitMessage('');
      onDirtyChange(false);
      setNotice(`Published revision ${res.page.revision} to the live website.`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError('Another administrator published changes while you were editing. Refresh the page to load the latest version before publishing.');
      } else {
        setError(caught instanceof Error ? caught.message : 'Could not publish page.');
      }
    } finally {
      setSaving(false);
    }
  };

  const previewDocument: PageDocument = useMemo(
    () => ({
      schemaVersion: 1,
      slug,
      revision: serverPage?.revision ?? 0,
      updatedAt: serverPage?.updatedAt ?? new Date().toISOString(),
      updatedBy: serverPage?.updatedBy ?? 'preview',
      seo,
      blocks,
    }),
    [slug, serverPage, seo, blocks]
  );

  const previewSrcDoc = useMemo(() => {
    const baseHref = siteOriginFor(mode);
    const html = renderPageHtml(previewDocument, {
      assetOrigin: window.location.origin,
      driveCaches,
    });
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <base href="${baseHref}/" />
    <style>
      @font-face {
        font-family: 'Montserrat';
        font-style: normal;
        font-weight: 400;
        src: url('/original/f0590551705610cd6f12.woff2') format('woff2');
      }
      @font-face {
        font-family: 'Montserrat';
        font-style: normal;
        font-weight: 700;
        src: url('/original/e3eaef581648e55226f1.woff2') format('woff2');
      }
      :root { --maroon: #7a003c; --gold: #fdbf57; }
      body { margin: 0; font-family: 'Montserrat', Arial, sans-serif; color: #2a2a2a; background: #fff; line-height: 1.65; }
      .container { max-width: 1120px; margin: 0 auto; padding: 28px 24px; }
      h2.wsite-content-title { font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 28px; margin: 0 0 16px; color: #2a2a2a; }
      a { color: #7a003c; }
      .paragraph { margin: 0 0 14px; font-family: 'Montserrat', sans-serif; font-size: 16px; line-height: 1.85; color: #2a2a2a; }
      ${websiteFaqCss}
      ${websiteTeamCss}
      ${websiteContentCss}
    </style>
  </head>
  <body>
    <main id="wsite-content">${html}</main>
  </body>
</html>`;
  }, [previewDocument, driveCaches, mode]);

  const liveUrl = mode === 'local' ? `http://127.0.0.1:4323${meta.path}` : `https://mmb.nickly.me${meta.path}`;

  return (
    <div className="page-editor-root">
      <div className="page-heading">
        <div>
          <h1>{meta.label}</h1>
          {serverPage && (
            <p className="page-status-line">
              Revision {serverPage.revision}
              {serverPage.gitSha ? ` · Git ${serverPage.gitSha.slice(0, 7)}` : ''}
              {serverPage.updatedBy && serverPage.updatedBy !== 'unseeded' ? ` · Last updated by ${serverPage.updatedBy}` : ''}
              {' · '}
              <span className="history-badge">{historyProvider === 'github' ? 'GitHub history active' : 'Local R2 history'}</span>
            </p>
          )}
        </div>
        <div className="page-heading-actions">
          <a className="button button-secondary" href={liveUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="arrow" size={14} /> View live
          </a>
          <button type="button" className="button button-secondary" onClick={() => setHistoryOpen(true)} disabled={loading}>
            <Icon name="history" size={15} /> History
          </button>
          <button type="button" className="button button-primary" onClick={() => void publish()} disabled={loading || saving || !isDirty}>
            <Icon name="check" size={15} /> {saving ? 'Publishing…' : isDirty ? 'Publish changes' : 'Published'}
          </button>
        </div>
      </div>

      {error && (
        <div className="form-error page-error" role="alert">
          <span>{error}</span>
          <button className="text-button" type="button" onClick={() => void loadPage()}>Reload latest</button>
        </div>
      )}
      {notice && (
        <div className="success-notice" role="status">
          <Icon name="check" size={16} />
          {notice}
          <button className="icon-button" type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-state" role="status">
          <span className="loading-spinner" />
          Loading {meta.label}…
        </div>
      ) : (
        <>
          <div className="editor-toolbar-bar">
            <div className="mode-tabs editor-view-tabs" role="group" aria-label="Editor view">
              <button type="button" aria-pressed={viewMode === 'edit'} onClick={() => setViewMode('edit')}>
                <Icon name="edit" size={14} />{' '}
                {slug === 'faq' ? 'Edit questions' : slug === 'our-team' ? 'Edit team' : 'Edit blocks'}
              </button>
              <button type="button" aria-pressed={viewMode === 'rearrange'} onClick={() => setViewMode('rearrange')}>
                <Icon name="grip" size={14} /> Rearrange
              </button>
              <button type="button" aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}>
                Split view
              </button>
              <button type="button" aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}>
                <Icon name="eye" size={14} /> Live preview
              </button>
            </div>
            <div className="editor-commit-bar">
              <button type="button" className="button button-secondary button-sm" onClick={() => setSeoOpen(v => !v)}>
                <Icon name="globe" size={14} /> {seoOpen ? 'Hide SEO' : 'SEO Settings'}
              </button>
              <input
                className="commit-message-input"
                value={commitMessage}
                onChange={e => setCommitMessage(e.target.value)}
                placeholder="Optional change summary for version history…"
                maxLength={240}
              />
            </div>
          </div>

          {seoOpen && (
            <section className="seo-panel" aria-label="Page SEO settings">
              <div className="field-row">
                <label>
                  <span>Page &lt;title&gt;</span>
                  <input value={seo.title} maxLength={160} onChange={e => setSeo(prev => ({ ...prev, title: e.target.value }))} />
                </label>
                <label>
                  <span>Meta description</span>
                  <input value={seo.description} maxLength={320} onChange={e => setSeo(prev => ({ ...prev, description: e.target.value }))} />
                </label>
              </div>
            </section>
          )}

          <div className={`editor-workspace view-${viewMode === 'rearrange' ? 'edit' : viewMode}`}>
            {viewMode !== 'preview' && (
              <div className="editor-pane">
                {slug === 'faq' ? (
                  <FaqEditor blocks={blocks} mode={mode} onChange={setBlocks} rearrangeMode={viewMode === 'rearrange'} />
                ) : slug === 'our-team' ? (
                  <TeamEditor blocks={blocks} mode={mode} onChange={setBlocks} rearrangeMode={viewMode === 'rearrange'} />
                ) : (
                  <BlockComposer
                    blocks={blocks}
                    mode={mode}
                    onChange={setBlocks}
                    rearrangeMode={viewMode === 'rearrange'}
                    driveCaches={driveCaches}
                    onDriveCacheUpdated={cache => setDriveCaches(prev => ({ ...prev, [cache.folderId]: cache }))}
                    driveConfigured={driveConfigured}
                  />
                )}
              </div>
            )}
            {(viewMode === 'split' || viewMode === 'preview') && (
              <div className="preview-pane">
                <div className="preview-pane-header">
                  <strong>Live Preview</strong>
                  <span>{seo.title}</span>
                </div>
                <iframe
                  title={`${meta.label} preview`}
                  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={previewSrcDoc}
                />
              </div>
            )}
          </div>
        </>
      )}

      {historyOpen && serverPage && (
        <HistoryDrawer
          slug={slug}
          mode={mode}
          currentRevision={serverPage.revision}
          currentGitSha={serverPage.gitSha}
          onClose={() => setHistoryOpen(false)}
          onRestored={restored => {
            setServerPage(restored);
            setSeo(restored.seo);
            setBlocks(restored.blocks);
            onDirtyChange(false);
            setNotice(`Restored ${meta.label} (now revision ${restored.revision}).`);
          }}
        />
      )}
    </div>
  );
}
