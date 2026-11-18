import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { youtubeEmbed, type GalleryItem } from '@mmb/gallery';
import { api, ApiError, uploadFile } from './api';
import { processPhoto, processVideo, type ProcessedMedia } from './media-processing';
import { fileKey, mediaKind, mergeFiles } from './upload-selection';
import { Icon, Modal } from './ui';

type ItemResult = { item: GalleryItem; revision: number };
type Status = { state: 'queued' | 'uploading' | 'complete' | 'failed' | 'canceled'; percent: number; label: string };
type Stage = { requestId: string; processed?: ProcessedMedia; originalKey?: string; thumbnailKey?: string; body?: Record<string, unknown>; saveAttempted?: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : 'This file could not be added. Please try again.';
const filenameTitle = (file: File) => file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 240) || 'Untitled video';

async function discardStages(stages: Stage[]) {
  const keys = [...new Set(stages.flatMap(stage => [stage.originalKey, stage.thumbnailKey].filter((key): key is string => Boolean(key))))];
  for (let offset = 0; offset < keys.length; offset += 40) await api('/api/admin/uploads/discard', { method: 'POST', body: JSON.stringify({ keys: keys.slice(offset, offset + 40) }) });
}

export default function UploadDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (item: GalleryItem) => void }) {
  const [mode, setMode] = useState<'media' | 'youtube'>('media');
  const [files, setFiles] = useState<File[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [caption, setCaption] = useState('');
  const [detail, setDetail] = useState('');
  const [url, setUrl] = useState('');
  const [published, setPublished] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const stages = useRef(new Map<string, Stage>());
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);
  const youtubeRequestId = useRef(crypto.randomUUID());
  const youtubeBody = useRef<Record<string, unknown> | undefined>(undefined);
  const youtubeUncertain = useRef(false);
  const settled = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const urls = Object.fromEntries(files.filter(file => mediaKind(file) === 'photo').map(file => [fileKey(file), URL.createObjectURL(file)]));
    setPreviews(urls);
    return () => Object.values(urls).forEach(URL.revokeObjectURL);
  }, [files]);
  useEffect(() => () => {
    controller.current?.abort();
    // A submitted save may still commit even if its response is lost. Never
    // delete its files from an unmount cleanup; an explicit retry reconciles it.
    void settled.current.then(() => discardStages([...stages.current.values()].filter(stage => !stage.saveAttempted))).catch(() => {});
  }, []);

  const photos = files.filter(file => mediaKind(file) === 'photo').length;
  const videos = files.length - photos;
  const complete = files.filter(file => statuses[fileKey(file)]?.state === 'complete').length;
  const remaining = files.length - complete;
  const totalPercent = files.length ? Math.round(files.reduce((sum, file) => sum + (statuses[fileKey(file)]?.percent || 0), 0) / files.length) : 0;
  const settingsLocked = busy || started;
  async function reconcileAndDiscard(entries: Stage[]) {
    for (const stage of entries) if (stage.saveAttempted && stage.body) {
      const result = await api<ItemResult>('/api/admin/items', { method: 'POST', body: JSON.stringify(stage.body), signal: AbortSignal.timeout(30000) });
      onAdded(result.item);
    }
    await discardStages(entries.filter(stage => !stage.saveAttempted));
  }
  function status(key: string, state: Status['state'], percent: number, label: string) {
    setStatuses(current => ({ ...current, [key]: { state, percent: state === 'complete' ? 100 : Math.max(current[key]?.percent || 0, percent), label } }));
  }
  function chooseFiles(incoming: File[]) {
    if (active.current) return;
    setError('');
    try { setFiles(mergeFiles(files, incoming)); } catch (caught) { setError(message(caught)); }
  }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); chooseFiles([...event.dataTransfer.files]); }
  async function close() {
    if (active.current) return;
    active.current = true; setBusy(true);
    try { await reconcileAndDiscard([...stages.current.values()]); stages.current.clear(); onClose(); }
    catch { setError('Unused uploads could not be cleared. Check your connection and try closing again.'); }
    finally { active.current = false; setBusy(false); }
  }
  async function remove(file: File) {
    if (active.current) return;
    const key = fileKey(file), stage = stages.current.get(key);
    active.current = true; setBusy(true);
    try {
      if (stage) await reconcileAndDiscard([stage]);
      stages.current.delete(key); setFiles(current => current.filter(value => fileKey(value) !== key));
      setStatuses(current => { const next = { ...current }; delete next[key]; return next; });
    }
    catch (caught) { setError(message(caught)); }
    finally { active.current = false; setBusy(false); }
  }
  async function changeMode(next: 'media' | 'youtube') {
    if (active.current || next === mode) return;
    active.current = true; setBusy(true);
    try {
      await reconcileAndDiscard([...stages.current.values()]); stages.current.clear(); setFiles([]); setStatuses({}); setError(''); setStarted(false); setMode(next);
      youtubeBody.current = undefined; youtubeUncertain.current = false; youtubeRequestId.current = crypto.randomUUID();
    }
    catch (caught) { setError(message(caught)); }
    finally { active.current = false; setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    setError('');
    if (mode === 'media' && !remaining) { setError('Choose photos or videos to upload.'); return; }
    if (mode === 'youtube' && !youtubeEmbed(url)) { setError('Enter a valid YouTube video link.'); return; }
    if (mode === 'youtube' && !caption.trim()) { setError('Give this video a title.'); return; }
    if (mode === 'youtube' && url.length > 2048) { setError('Use a YouTube link of 2048 characters or fewer.'); return; }
    active.current = true; setBusy(true); setStarted(true);
    const operation = new AbortController(); controller.current = operation;
    let finishOperation!: () => void;
    settled.current = new Promise(resolve => { finishOperation = resolve; });
    try {
      if (mode === 'youtube') {
        youtubeBody.current ||= { clientRequestId: youtubeRequestId.current, kind: 'video', provider: 'youtube', year, title: caption, note: detail, published, url };
        const previouslyUncertain = youtubeUncertain.current;
        youtubeUncertain.current = true;
        try {
          const result = await api<ItemResult>('/api/admin/items', { method: 'POST', signal: AbortSignal.timeout(30000), body: JSON.stringify(youtubeBody.current) });
          youtubeUncertain.current = false; onAdded(result.item); onClose(); return;
        } catch (caught) {
          if (!previouslyUncertain && caught instanceof ApiError && [400, 401, 403, 404, 409, 413, 415, 422].includes(caught.status)) {
            youtubeUncertain.current = false; youtubeBody.current = undefined; setStarted(false);
          }
          throw caught;
        }
      }
      const pending = files.filter(file => statuses[fileKey(file)]?.state !== 'complete');
      let cursor = 0, added = 0, failed = 0;
      // Bound decoding, browser memory, multipart requests, and catalog writes.
      async function worker() {
        while (!operation.signal.aborted) {
          const file = pending[cursor++]; if (!file) return;
          const key = fileKey(file), kind = mediaKind(file);
          const stage = stages.current.get(key) || { requestId: crypto.randomUUID() };
          const previouslyAttempted = stage.saveAttempted;
          stages.current.set(key, stage);
          try {
            status(key, 'uploading', 2, 'Preparing preview');
            stage.processed ||= await (kind === 'photo' ? processPhoto : processVideo)(file, operation.signal);
            stage.originalKey ||= await uploadFile(file, operation.signal, fraction => status(key, 'uploading', 8 + fraction * 70, 'Uploading file'));
            stage.thumbnailKey ||= await uploadFile(stage.processed.thumbnail, operation.signal, fraction => status(key, 'uploading', 78 + fraction * 15, 'Uploading preview'));
            operation.signal.throwIfAborted();
            const { thumbnail: _, ...metadata } = stage.processed;
            stage.body ||= {
              clientRequestId: stage.requestId, year, published, originalKey: stage.originalKey, thumbnailKey: stage.thumbnailKey, ...metadata,
              ...(kind === 'photo' ? { kind, caption, alt: (detail || caption || filenameTitle(file)).slice(0, 500) } : { kind, provider: 'upload', title: caption.trim().slice(0, 240) || filenameTitle(file), note: detail, contentType: file.type }),
            };
            status(key, 'uploading', 95, 'Saving to gallery');
            // Retain the same request ID and media keys for uncertain-save retries.
            stage.saveAttempted = true;
            // Once saving begins, finish this atomic item before honoring a
            // cancellation. The next file still observes the canceled signal.
            const result = await api<ItemResult>('/api/admin/items', { method: 'POST', signal: AbortSignal.timeout(30000), body: JSON.stringify(stage.body) });
            stages.current.delete(key); added++; status(key, 'complete', 100, 'Added to gallery'); onAdded(result.item);
          } catch (caught) {
            if (!previouslyAttempted && caught instanceof ApiError && [400, 401, 403, 404, 409, 413, 415, 422].includes(caught.status)) stage.saveAttempted = false;
            failed++; status(key, operation.signal.aborted ? 'canceled' : 'failed', 0, operation.signal.aborted ? 'Canceled — ready to resume' : message(caught));
            if (caught instanceof ApiError && [401, 403].includes(caught.status)) operation.abort();
          }
        }
      }
      await Promise.all([worker(), worker()]);
      if (added === pending.length) { onClose(); return; }
      const summary = `${complete + added} of ${files.length} files added.`;
      setError(operation.signal.aborted ? `${summary} Upload stopped. Resume the remaining files or close this window to discard unused uploads.` : `${summary} ${failed} ${failed === 1 ? 'file needs' : 'files need'} attention. Fix the issue and retry the remaining files.`);
    } catch (caught) { setError(message(caught)); }
    finally { controller.current = null; active.current = false; setBusy(false); finishOperation(); }
  }

  const mixed = photos > 0 && videos > 0;
  const captionLabel = mode === 'youtube' || (videos > 0 && !photos) ? 'Video title' : mixed ? 'Caption / video title' : 'Caption';
  return <Modal title="Add to the gallery" description="Upload up to 100 photos and videos together, or add a YouTube link." onClose={() => void close()} busy={busy} wide>
    <form onSubmit={save} className="editor-form">
      <div className="mode-tabs" role="group" aria-label="What would you like to add?">
        <button type="button" aria-pressed={mode === 'media'} disabled={busy} onClick={() => void changeMode('media')}><Icon name="upload" size={17} />Photos &amp; videos</button>
        <button type="button" aria-pressed={mode === 'youtube'} disabled={busy} onClick={() => void changeMode('youtube')}><Icon name="video" size={17} />YouTube link</button>
      </div>
      {mode === 'youtube' ? <label>YouTube link<input type="url" required placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={event => setUrl(event.target.value)} disabled={settingsLocked} /></label> : <>
        <div className={`drop-zone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop} aria-disabled={busy}>
          <Icon name="upload" size={30} /><strong>Drop photos and videos here</strong><span>Select both together, up to 100 files per upload</span>
          <label className="button button-secondary file-picker">Choose photos &amp; videos<input aria-label="Choose photos and videos" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" multiple onChange={event => { chooseFiles([...event.target.files || []]); event.target.value = ''; }} disabled={busy} /></label>
          <small>JPEG, PNG, WebP, GIF · 25 MB per photo<br />MP4, WebM · 1 GB per video</small>
        </div>
        {files.length > 0 && <>
          <div className="batch-summary"><strong>{files.length} / 100 files</strong><span>{photos} {photos === 1 ? 'photo' : 'photos'} · {videos} {videos === 1 ? 'video' : 'videos'}{complete > 0 ? ` · ${complete} added` : ''}</span></div>
          <ul className="selected-files" aria-label="Selected uploads">{files.map(file => { const key = fileKey(file), result = statuses[key]; return <li key={key}>
            <div className="selected-file-preview">{mediaKind(file) === 'photo' ? <img src={previews[key]} alt="" loading="lazy" decoding="async" /> : <Icon name="video" />}</div>
            <span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>{result && <span className={`file-status ${result.state}`} title={result.label}>{result.state === 'uploading' ? `${result.label} · ${Math.round(result.percent)}%` : result.label}</span>}</span>
            {result?.state === 'complete' ? <Icon name="check" size={18} /> : <button className="icon-button" type="button" aria-label={`Remove ${file.name} from selection`} disabled={busy} onClick={() => void remove(file)}><Icon name="close" size={16} /></button>}
          </li>; })}</ul>
        </>}
      </>}
      <div className="form-two-columns"><label>Year<input type="number" required min="2000" max="2100" value={year} disabled={settingsLocked} onChange={event => setYear(Number(event.target.value))} /></label><div className="publish-field"><label className="checkbox-label"><input type="checkbox" checked={published} disabled={settingsLocked} onChange={event => setPublished(event.target.checked)} /><span>Publish immediately</span></label><span className="field-hint">Turn off to keep these items hidden until they are ready.</span></div></div>
      <label>{captionLabel}<input aria-label={captionLabel} value={caption} maxLength={videos || mode === 'youtube' ? 240 : 2000} required={mode === 'youtube'} disabled={settingsLocked} placeholder={mode === 'youtube' ? 'Name this performance' : 'Optional shared caption or title'} onChange={event => setCaption(event.target.value)} /><span className="field-hint">{mode === 'media' ? 'Applies to this upload. Videos use their filename when no title is entered.' : 'Give this video a title.'}</span></label>
      <label>{mode === 'youtube' || (videos && !photos) ? 'Video notes' : mixed ? 'Image descriptions / video notes' : 'Image description'}<textarea rows={2} value={detail} maxLength={videos || mode === 'youtube' ? 4000 : 500} disabled={settingsLocked} onChange={event => setDetail(event.target.value)} /><span className="field-hint">{mixed ? 'Shared notes for videos; the first 500 characters describe photos for screen readers.' : 'Optional description or context for this upload.'}</span></label>
      {busy && <div className="upload-progress" role="status" aria-live="polite"><div><span>{mode === 'youtube' ? 'Saving YouTube video…' : `${complete} of ${files.length} files added`}</span><strong>{totalPercent}%</strong></div><progress aria-label="Overall upload progress" max="100" value={totalPercent} /></div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions">{busy ? <button type="button" className="button button-secondary" onClick={() => controller.current?.abort()}>Cancel upload</button> : <button type="button" className="button button-secondary" onClick={() => void close()}>Cancel</button>}<button className="button button-primary" disabled={busy || (mode === 'media' && !remaining)}>{busy ? 'Adding…' : complete > 0 || Object.keys(statuses).length ? 'Retry remaining files' : published ? 'Add to gallery' : 'Save hidden item'}</button></div>
    </form>
  </Modal>;
}
