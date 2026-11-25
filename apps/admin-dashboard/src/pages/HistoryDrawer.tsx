import { useEffect, useState } from 'react';
import { renderPageHtml, type PageDocument, type PageSlug } from '@mmb/content';
import { api } from '../api';
import { Icon, Modal } from '../ui';
import { siteOriginFor, type AdminMode } from './asset-urls';

type VersionSummary = {
  versionId: string;
  shortId: string;
  message: string;
  author: string;
  timestamp: string;
  source: 'github' | 'r2';
};

export default function HistoryDrawer({
  slug,
  mode,
  currentRevision,
  currentGitSha,
  onClose,
  onRestored,
}: {
  slug: PageSlug;
  mode: AdminMode;
  currentRevision: number;
  currentGitSha?: string;
  onClose: () => void;
  onRestored: (page: PageDocument) => void;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [provider, setProvider] = useState<'github' | 'r2'>('r2');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previewDoc, setPreviewDoc] = useState<PageDocument | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busyRestore, setBusyRestore] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<{ versions: VersionSummary[]; provider: 'github' | 'r2' }>(`/api/admin/pages/${slug}/history`)
      .then(res => {
        if (!active) return;
        setVersions(res.versions);
        setProvider(res.provider);
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load version history.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const loadPreview = async (versionId: string) => {
    setPreviewId(versionId);
    setError('');
    try {
      const res = await api<{ page: PageDocument }>(`/api/admin/pages/${slug}/history/${encodeURIComponent(versionId)}`);
      setPreviewDoc(res.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load version preview.');
    }
  };

  const restore = async (versionId: string) => {
    setBusyRestore(versionId);
    setError('');
    try {
      const res = await api<{ page: PageDocument }>(`/api/admin/pages/${slug}/rollback`, {
        method: 'POST',
        body: JSON.stringify({
          versionId,
          expectedRevision: currentRevision,
          ...(currentGitSha ? { expectedGitSha: currentGitSha } : {}),
        }),
      });
      onRestored(res.page);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore this version.');
    } finally {
      setBusyRestore(null);
    }
  };

  return (
    <Modal
      title="Version History"
      description={provider === 'github' ? 'Backed by the dedicated GitHub content repository.' : 'Local R2 revision history (GitHub history activates when configured).'}
      onClose={onClose}
      busy={Boolean(busyRestore)}
      wide
    >
      <div className="history-modal-body">
        {error && <div className="form-error">{error}</div>}
        {loading ? (
          <div className="loading-state">
            <span className="loading-spinner" />
            <span>Loading versions…</span>
          </div>
        ) : !versions.length ? (
          <p className="history-empty">No saved revisions yet. Publish your first update to record history.</p>
        ) : (
          <div className="history-layout">
            <ul className="history-list">
              {versions.map(v => (
                <li key={v.versionId} className={previewId === v.versionId ? 'is-selected' : ''}>
                  <div className="history-meta">
                    <span className="history-sha">{v.shortId}</span>
                    <time>{v.timestamp ? new Date(v.timestamp).toLocaleString() : ''}</time>
                  </div>
                  <strong>{v.message}</strong>
                  <small>{v.author}</small>
                  <div className="history-actions">
                    <button type="button" className="text-button" onClick={() => void loadPreview(v.versionId)}>
                      <Icon name="eye" size={14} /> Preview
                    </button>
                    <button
                      type="button"
                      className="button button-secondary button-sm"
                      disabled={Boolean(busyRestore)}
                      onClick={() => void restore(v.versionId)}
                    >
                      {busyRestore === v.versionId ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="history-preview-pane">
              {previewDoc ? (
                <iframe
                  title="Historical version preview"
                  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={`<!doctype html><html><head><base href="${siteOriginFor(mode)}/" /><style>body{font-family:Montserrat,Arial,sans-serif;margin:16px;color:#292929;}h2,h3{color:#7a003c;}a{color:#7a003c;}.mmb-doc-card{border:1px solid #ddd;padding:10px;margin:8px 0;display:flex;justify-content:space-between;align-items:center;}</style></head><body>${renderPageHtml(previewDoc, { assetOrigin: window.location.origin })}</body></html>`}
                />
              ) : (
                <div className="history-preview-empty">Select &ldquo;Preview&rdquo; on any version to inspect its content before restoring.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
