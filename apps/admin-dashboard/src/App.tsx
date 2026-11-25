import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PAGE_METADATA, PAGE_SLUGS, isPageSlug, type PageSlug } from '@mmb/content';
import type { GalleryItem, GalleryPhoto } from '@mmb/gallery';
import { api, ApiError } from './api';
import ImageViewerModal, { extractFilename, type ImageViewerItem } from './ImageViewerModal';
import PageEditor, { prefetchPage } from './pages/PageEditor';
import { Icon, Modal, Toast, type IconName, type ToastMessage } from './ui';
import AddDialog from './UploadDialog';

type Session = {
  email: string;
  mediaOrigin: string;
  mode: 'local' | 'production';
  githubConfigured?: boolean;
  driveConfigured?: boolean;
};
type ItemResult = { item: GalleryItem; revision: number };
type RouteView = { kind: 'gallery' } | { kind: 'page'; slug: PageSlug };

const PAGE_ICONS: Record<PageSlug, IconName> = {
  faq: 'help',
  'our-team': 'users',
  budget: 'file',
  constitution: 'book',
  'executive-meeting-minutes': 'folder',
};

function parseRoute(pathname: string): RouteView {
  const match = pathname.match(/^\/pages\/([a-z0-9-]+)\/?$/);
  if (match && isPageSlug(match[1])) return { kind: 'page', slug: match[1] };
  return { kind: 'gallery' };
}

function resolveGalleryMediaUrl(raw: string): string {
  try {
    const url = new URL(raw, window.location.origin);
    return url.pathname.startsWith('/media/') ? url.pathname : raw;
  } catch {
    return raw;
  }
}

function photoViewerItem(item: GalleryPhoto): ImageViewerItem {
  const src = resolveGalleryMediaUrl(item.src);
  return {
    src,
    alt: item.alt || item.caption || undefined,
    filename: extractFilename(item.originalKey || src) || undefined,
    width: item.width,
    height: item.height,
  };
}

const loadedPreviewUrls = new Set<string>();

function Preview({ item, large = false }: { item: GalleryItem; large?: boolean }) {
  const image = item.kind === 'photo' ? item.thumbnail : item.poster;
  const placeholder = item.placeholder;
  const local = image ? resolveGalleryMediaUrl(image) : undefined;
  const cached = Boolean(local && loadedPreviewUrls.has(local));
  const [ready, setReady] = useState(cached);
  const [instant, setInstant] = useState(cached);

  useEffect(() => {
    const isCached = Boolean(local && loadedPreviewUrls.has(local));
    setReady(isCached);
    setInstant(isCached);
  }, [local]);

  return <div className={`media-preview ${large ? 'preview-large' : ''}`} style={placeholder ? { backgroundImage: `url("${placeholder}")` } : undefined}>
    {local ? (
      <img
        key={local}
        ref={img => {
          if (img && img.complete && img.naturalWidth > 0) {
            loadedPreviewUrls.add(local);
            if (!ready) {
              setInstant(true);
              setReady(true);
            }
          }
        }}
        src={local}
        alt={item.kind === 'photo' ? item.alt : item.title}
        loading="lazy"
        onLoad={() => {
          loadedPreviewUrls.add(local);
          setReady(true);
        }}
        className={ready ? (instant ? 'is-ready is-instant' : 'is-ready') : ''}
      />
    ) : (
      <div className="video-placeholder"><Icon name="video" size={40} /><span>{item.kind === 'video' && item.provider === 'youtube' ? 'YouTube video' : 'Video'}</span></div>
    )}
    {item.kind === 'video' && <span className="preview-play" aria-hidden="true">▶</span>}
  </div>;
}

function itemTitle(item: GalleryItem) { return item.kind === 'photo' ? item.caption || item.alt || 'Untitled photo' : item.title; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

function EditDialog({ item, onClose, onSaved, onViewImage }: { item: GalleryItem; onClose: () => void; onSaved: (item: GalleryItem) => void; onViewImage: (image: ImageViewerItem) => void }) {
  const [year, setYear] = useState(item.year);
  const [caption, setCaption] = useState(item.kind === 'photo' ? item.caption : item.title);
  const [detail, setDetail] = useState(item.kind === 'photo' ? item.alt : item.note);
  const [published, setPublished] = useState(item.published);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<ItemResult>(`/api/admin/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ year, published, expectedUpdatedAt: item.updatedAt, ...(item.kind === 'photo' ? { caption, alt: detail } : { title: caption, note: detail }) }) });
      onSaved(result.item); onClose();
    } catch (caught) { setError(caught instanceof ApiError && caught.status === 409 ? 'This item was updated by another administrator. Close this window, refresh the gallery, and open it again before saving.' : errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <Modal title={item.kind === 'photo' ? 'Edit photo' : 'Edit video'} onClose={onClose} busy={busy}>
    <form onSubmit={save} className="editor-form">
      {item.kind === 'photo' ? (
        <button
          type="button"
          className="edit-photo-preview-trigger"
          onClick={() => onViewImage(photoViewerItem(item))}
          aria-label={`View full-size photo: ${itemTitle(item)}`}
          title="Click to view full-size image"
        >
          <Preview item={item} large />
          <span className="preview-inspect-badge" aria-hidden="true">
            <Icon name="eye" size={13} /> View full size
          </span>
        </button>
      ) : (
        <Preview item={item} large />
      )}
      <label>Year<input type="number" min="2000" max="2100" required value={year} onChange={event => setYear(Number(event.target.value))} /></label>
      <label>{item.kind === 'photo' ? 'Caption' : 'Video title'}<input value={caption} maxLength={item.kind === 'photo' ? 2000 : 240} required={item.kind === 'video'} onChange={event => setCaption(event.target.value)} placeholder={item.kind === 'photo' ? 'What was happening?' : 'Name this performance'} /></label>
      <label>{item.kind === 'photo' ? 'Image description' : 'Video notes'}<textarea rows={3} value={detail} maxLength={item.kind === 'photo' ? 500 : 4000} onChange={event => setDetail(event.target.value)} /><span className="field-hint">{item.kind === 'photo' ? 'A brief description:' : 'Optional details, such as when the band appears in the recording.'}</span></label>
      <label className="checkbox-label"><input type="checkbox" checked={published} onChange={event => setPublished(event.target.checked)} /><span>Visible in the public gallery</span></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  </Modal>;
}

function RemoveDialog({ item, onClose, onRemoved }: { item: GalleryItem; onClose: () => void; onRemoved: (id: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function remove() {
    setBusy(true); setError('');
    try { await api(`/api/admin/items/${item.id}`, { method: 'DELETE', body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }) }); onRemoved(item.id); onClose(); }
    catch (caught) { setError(errorMessage(caught)); setBusy(false); }
  }
  return <Modal title="Remove from gallery?" onClose={onClose} busy={busy}>
    <p className="remove-description">Remove <strong>{itemTitle(item)}</strong> from {item.year}? It will no longer appear in the public gallery.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Keep item</button><button type="button" className="button button-danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove item'}</button></div>
  </Modal>;
}

export default function App() {
  const [route, setRoute] = useState<RouteView>(() => parseRoute(window.location.pathname));
  const [pageDirty, setPageDirty] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [unauthorized, setUnauthorized] = useState(false);
  const [search, setSearch] = useState(''), [year, setYear] = useState('all'), [kind, setKind] = useState('all'), [visibility, setVisibility] = useState('all');
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<GalleryItem | null>(null), [removing, setRemoving] = useState<GalleryItem | null>(null), [viewingImage, setViewingImage] = useState<ImageViewerItem | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastIdRef = useRef(0);
  const notify = useCallback((text: string) => {
    setToast({ id: ++toastIdRef.current, text });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!pageDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [pageDirty]);

  const navigate = (next: RouteView) => {
    if (route.kind === next.kind && (route.kind === 'gallery' || (next.kind === 'page' && route.slug === next.slug))) return;
    if (pageDirty && !window.confirm('You have unpublished changes on this page. Discard them and switch views?')) return;
    const targetPath = next.kind === 'gallery' ? '/' : `/pages/${next.slug}`;
    window.history.pushState(null, '', targetPath);
    window.scrollTo({ top: 0, behavior: 'instant' });
    setPageDirty(false);
    setRoute(next);
  };

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const identity = await api<Session>('/api/admin/session', { signal });
      const result = await api<{ items: GalleryItem[] }>('/api/admin/items', { signal });
      if (signal?.aborted) return;
      setSession(identity); setItems(result.items); setUnauthorized(false);
    } catch (caught) {
      if (signal?.aborted) return;
      setUnauthorized(caught instanceof ApiError && (caught.status === 401 || caught.status === 403)); setError(errorMessage(caught));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const update = (item: GalleryItem) => setItems(current => current.some(existing => existing.id === item.id) ? current.map(existing => existing.id === item.id ? item : existing) : [item, ...current]);
  const years = [...new Set(items.map(item => item.year))].sort((a, b) => b - a);
  const yearIndex = year === 'all' ? -1 : years.indexOf(Number(year));
  useEffect(() => {
    if (year !== 'all' && !items.some(item => item.year === Number(year))) setYear('all');
  }, [items, year]);
  const filtered = items.filter(item => (year === 'all' || item.year === Number(year)) && (kind === 'all' || item.kind === kind) && (visibility === 'all' || item.published === (visibility === 'published')) && `${itemTitle(item)} ${item.kind === 'photo' ? item.alt : item.note}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.year - a.year || a.order - b.order || b.createdAt.localeCompare(a.createdAt));
  async function toggle(item: GalleryItem) {
    setWorking(item.id); setError('');
    try { const result = await api<ItemResult>(`/api/admin/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ published: !item.published, expectedUpdatedAt: item.updatedAt }) }); update(result.item); notify(result.item.published ? 'Item published to the gallery.' : 'Item hidden from the public gallery.'); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setWorking(null); }
  }
  if (unauthorized) return <main className="access-screen"><div className="access-mark"><Icon name="lock" size={30} /></div><h1>MMB Administration</h1><p>{error || 'Sign in with an administrator email to manage the website.'}</p><a className="button button-primary" href="/cdn-cgi/access/login">Sign in</a><button type="button" className="text-button" onClick={() => void load()}>Try again</button><a href="https://mmb.nickly.me">Return to the website</a></main>;

  const publicHref = session?.mode === 'local'
    ? `http://127.0.0.1:4323${route.kind === 'page' ? PAGE_METADATA[route.slug].path : '/gallery'}`
    : `https://mmb.nickly.me${route.kind === 'page' ? PAGE_METADATA[route.slug].path : '/gallery'}`;

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <a className="admin-wordmark" href="/" onClick={e => { e.preventDefault(); navigate({ kind: 'gallery' }); }}>
        <img className="band-logo" src="https://mmb.nickly.me/original/6477f7b65c749071b5d7.png" alt="McMaster Marching Band logo" width="64" height="50" />
        <span>McMaster<br /><strong>Marching Band</strong></span>
      </a>
      <div className="workspace-label">Administration</div>
      <nav aria-label="Administration">
        <a
          className={`sidebar-link ${route.kind === 'gallery' ? 'active' : ''}`}
          href="/"
          aria-current={route.kind === 'gallery' ? 'page' : undefined}
          onClick={e => { e.preventDefault(); navigate({ kind: 'gallery' }); }}
        >
          <Icon name="gallery" />Gallery
        </a>
      </nav>
      <div className="workspace-label">Website Pages</div>
      <nav aria-label="Website Pages">
        {PAGE_SLUGS.map(slug => {
          const active = route.kind === 'page' && route.slug === slug;
          return (
            <a
              key={slug}
              className={`sidebar-link ${active ? 'active' : ''}`}
              href={`/pages/${slug}`}
              aria-current={active ? 'page' : undefined}
              onMouseEnter={() => prefetchPage(slug)}
              onFocus={() => prefetchPage(slug)}
              onClick={e => { e.preventDefault(); navigate({ kind: 'page', slug }); }}
            >
              <Icon name={PAGE_ICONS[slug]} />{PAGE_METADATA[slug].label}
            </a>
          );
        })}
      </nav>
    </aside>
    <div className="admin-workspace">
      <header className="admin-topbar">
        <div className="mobile-wordmark">
          <img className="band-logo" src="https://mmb.nickly.me/original/6477f7b65c749071b5d7.png" alt="McMaster Marching Band logo" width="64" height="50" />
          <select
            aria-label="Switch admin section"
            className="mobile-nav-select"
            value={route.kind === 'gallery' ? 'gallery' : `page:${route.slug}`}
            onChange={e => {
              const val = e.target.value;
              if (val === 'gallery') navigate({ kind: 'gallery' });
              else if (val.startsWith('page:')) {
                const slug = val.slice(5);
                if (isPageSlug(slug)) navigate({ kind: 'page', slug });
              }
            }}
          >
            <option value="gallery">Gallery</option>
            {PAGE_SLUGS.map(slug => (
              <option key={slug} value={`page:${slug}`}>{PAGE_METADATA[slug].label}</option>
            ))}
          </select>
        </div>
        <span className="topbar-caption">McMaster Marching Band</span>
        <div className="topbar-actions">
          {session && <span className="account-email" title={session.email}>{session.email}</span>}
          <a href={publicHref} target="_blank" rel="noopener noreferrer">
            {route.kind === 'page' ? 'View page' : 'View gallery'}<Icon name="arrow" size={14} />
          </a>
          {session?.mode === 'production' && <a href="/cdn-cgi/access/logout" className="sign-out">Sign out</a>}
        </div>
      </header>
      <main className="admin-main">
        {session?.mode === 'local' && <div className="development-note">Local preview</div>}
        {route.kind === 'page' ? (
          <PageEditor key={route.slug} slug={route.slug} mode={session?.mode || 'local'} onDirtyChange={setPageDirty} onNotify={notify} />
        ) : (
          <>
            <div className="page-heading"><div><h1>Gallery</h1></div><button className="button button-primary" type="button" onClick={() => setAdding(true)} disabled={loading || !session}><Icon name="plus" />Add media</button></div>
            <div className="gallery-statistics" aria-label="Gallery summary"><div><span>Total items</span><strong>{loading && !items.length ? '—' : items.length}<small>photos & videos</small></strong></div><div><span>Published</span><strong>{loading && !items.length ? '—' : items.filter(item => item.published).length}<small>visible to everyone</small></strong></div><div><span>Hidden</span><strong>{loading && !items.length ? '—' : items.filter(item => !item.published).length}<small>invisible</small></strong></div></div>
            <section className="gallery-library" aria-labelledby="library-heading"><div className="library-heading"><h2 id="library-heading">Your media</h2><button type="button" className="text-button" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16} />{loading ? 'Refreshing…' : 'Refresh'}</button></div>
              <div className="gallery-year-navigation" role="group" aria-label="Gallery year">
                <button type="button" aria-label="Previous year" disabled={yearIndex < 0 || yearIndex === years.length - 1} onClick={() => setYear(String(years[yearIndex + 1]))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg></button>
                <div className="gallery-year-select"><select aria-label="Select gallery year" value={year} onChange={event => setYear(event.target.value)}><option value="all">All years</option>{years.map(value => <option key={value} value={value}>{value}</option>)}</select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></div>
                <button type="button" aria-label="Next year" disabled={yearIndex <= 0} onClick={() => setYear(String(years[yearIndex - 1]))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6M16 12H4" /></svg></button>
              </div>
              <div className="library-toolbar"><label className="search-field"><Icon name="search" size={18} /><input aria-label="Search gallery" placeholder="Search captions and titles" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="library-filters"><label className="filter-label"><span>Type</span><select aria-label="Filter by media type" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All media</option><option value="photo">Photos</option><option value="video">Videos</option></select></label><label className="filter-label"><span>Visibility</span><select aria-label="Filter by visibility" value={visibility} onChange={event => setVisibility(event.target.value)}><option value="all">Any visibility</option><option value="published">Published</option><option value="hidden">Hidden</option></select></label></div></div>
              {error && <div className="form-error page-error" role="alert"><span>{error}</span><button className="text-button" type="button" onClick={() => void load()}>Retry</button></div>}
              {loading && !items.length ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading your gallery…</div> : filtered.length ? <><p className="results-count">{filtered.length} {filtered.length === 1 ? 'item' : 'items'}{search || year !== 'all' || kind !== 'all' || visibility !== 'all' ? ' match your filters' : ' in your library'}</p><div className="admin-media-grid">{filtered.map(item => <article className="admin-media-card" key={item.id}><button className={`card-preview-button ${item.kind === 'photo' ? 'is-photo-preview' : ''}`} type="button" onClick={() => item.kind === 'photo' ? setViewingImage(photoViewerItem(item)) : setEditing(item)} aria-label={item.kind === 'photo' ? `View full-size photo: ${itemTitle(item)}` : `Edit ${itemTitle(item)}`} title={item.kind === 'photo' ? 'Click to view full-size image' : undefined}><Preview item={item} /><span className="media-type-badge"><Icon name={item.kind === 'photo' ? 'image' : 'video'} size={12} />{item.kind === 'photo' ? 'Photo' : 'Video'}</span>{item.kind === 'photo' && <span className="preview-inspect-badge" aria-hidden="true"><Icon name="eye" size={13} /> View</span>}</button><div className="card-details"><div className="card-meta"><span>{item.year}</span><span className={`visibility-badge ${item.published ? 'published' : ''}`}>{item.published ? 'Published' : 'Hidden'}</span></div><h3 title={itemTitle(item)}>{itemTitle(item)}</h3><div className="card-actions"><button type="button" className="card-action-icon" aria-label="Edit" title="Edit" onClick={() => setEditing(item)}><Icon name="edit" size={16} /></button><button type="button" className={`card-action-icon ${!item.published ? 'is-hidden-state' : ''}`} disabled={working === item.id} aria-label={working === item.id ? 'Saving…' : item.published ? 'Hide' : 'Publish'} title={working === item.id ? 'Saving…' : item.published ? 'Hide from public gallery' : 'Publish to public gallery'} onClick={() => void toggle(item)}><Icon name={item.published ? 'eye' : 'eyeOff'} size={16} /></button><button type="button" className="card-action-icon remove-link" aria-label="Remove" title="Remove" onClick={() => setRemoving(item)}><Icon name="trash" size={16} /></button></div></div></article>)}</div></> : !error && <div className="empty-state"><span className="empty-state-icon"><Icon name="gallery" size={30} /></span><h3>{items.length ? 'No matching media' : 'A new chapter starts here'}</h3><p>{items.length ? 'Try another year, type, or search term.' : 'Add your first photos or videos to bring the gallery to life.'}</p>{items.length ? <button className="button button-secondary" type="button" onClick={() => { setSearch(''); setYear('all'); setKind('all'); setVisibility('all'); }}>Clear filters</button> : <button className="button button-primary" type="button" onClick={() => setAdding(true)} disabled={!session}>Add media</button>}</div>}
            </section>
          </>
        )}
        <footer className="admin-footer">McMaster Marching Band <span>Website administration · 2026</span></footer>
      </main>
    </div>
    {adding && <AddDialog onClose={() => { setAdding(false); void load(); }} onAdded={item => { update(item); notify(item.published ? 'Added to the public gallery.' : 'Saved as a hidden item.'); }} />}
    {editing && <EditDialog item={editing} onClose={() => setEditing(null)} onSaved={item => { update(item); notify('Changes saved.'); }} onViewImage={setViewingImage} />}
    {removing && <RemoveDialog item={removing} onClose={() => setRemoving(null)} onRemoved={id => { setItems(current => current.filter(item => item.id !== id)); notify('Item removed from the gallery.'); }} />}
    {viewingImage && <ImageViewerModal item={viewingImage} onClose={() => setViewingImage(null)} />}
    <Toast toast={toast} onDismiss={dismissToast} />
  </div>;
}
