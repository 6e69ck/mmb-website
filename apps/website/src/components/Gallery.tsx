import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GalleryIndex, GalleryPhoto, GalleryVideo, MediaFilter } from '@mmb/gallery';

type Photo = Pick<GalleryPhoto, 'kind' | 'src' | 'thumbnail' | 'width' | 'height' | 'hash' | 'placeholder' | 'caption' | 'alt'> & Partial<GalleryPhoto>;
type Video = Pick<GalleryVideo, 'kind' | 'src' | 'title' | 'note'> & Partial<GalleryVideo>;
export type MediaItem = Photo | Video;
type Props = {
  years: number[];
  photoYears: number[];
  videoYears: number[];
  initialYear: number;
  initialItems: MediaItem[];
  initialType?: MediaFilter;
  preferredYear?: number;
  apiBase: string;
};
type Selection = { requestedYear?: number; type: MediaFilter; updateUrl?: boolean };
type Collection = Pick<GalleryIndex, 'years' | 'photoYears' | 'videoYears'>;
const yearsFor = (collection: Collection, type: MediaFilter) => type === 'videos' ? collection.videoYears : type === 'photos' ? collection.photoYears : collection.years;
const chooseYear = (available: number[], requested?: number, preferred?: number): number | null => available.includes(requested ?? NaN) ? requested! : available.includes(preferred ?? NaN) ? preferred! : available[0] ?? null;

async function fetchJson(url: string, signal: AbortSignal, fresh = true): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = window.setTimeout(cancel, 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: fresh ? 'no-store' : 'default' });
    if (!response.ok) throw new Error('Gallery request failed');
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

function validIndex(value: unknown): value is GalleryIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as GalleryIndex;
  return Number.isInteger(index.revision) && ['years', 'photoYears', 'videoYears'].every(key => {
    const years = index[key as keyof Collection];
    return Array.isArray(years) && years.every(year => Number.isInteger(year) && year >= 1900 && year <= 2200);
  });
}
function validAlbum(value: unknown): value is MediaItem[] {
  return Array.isArray(value) && value.every(item => item && typeof item.src === 'string' && (item.kind === 'photo' ? typeof item.thumbnail === 'string' && Number.isFinite(item.width) && Number.isFinite(item.height) : item.kind === 'video' && typeof item.title === 'string'));
}

export default function Gallery({ years, photoYears, videoYears, initialYear, initialItems, initialType = 'all', preferredYear, apiBase }: Props) {
  const snapshot = useRef<Collection>({ years, photoYears, videoYears });
  const snapshotCache = useRef(new Map<number, MediaItem[]>([[initialYear, initialItems]]));
  const [collection, setCollection] = useState<Collection>(snapshot.current);
  const [year, setYear] = useState<number | null>(initialYear);
  const [items, setItems] = useState(initialItems);
  const [mediaType, setMediaType] = useState<MediaFilter>(initialType);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [offline, setOffline] = useState(false);
  const [hasLiveData, setHasLiveData] = useState(false);
  const liveRevision = useRef<number | null>(null);
  const liveCache = useRef(new Map<number, MediaItem[]>());
  const displayedYear = useRef<number | null>(initialYear);
  const hadLiveData = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const isLoading = useRef(false);
  const base = apiBase.replace(/\/+$/, '');

  const loadSelection = useCallback(async ({ requestedYear, type, updateUrl = false }: Selection) => {
    const id = ++requestNumber.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    isLoading.current = true;
    setMediaType(type); setLoading(true); setError(false);
    const current = () => !controller.signal.aborted && id === requestNumber.current;
    const remember = (selected: number | null) => {
      if (!updateUrl || !current()) return;
      const url = new URL(window.location.href);
      if (selected === null) url.searchParams.delete('year');
      else url.searchParams.set('year', String(selected));
      if (type === 'all' && initialType === 'all') url.searchParams.delete('type');
      else url.searchParams.set('type', type);
      if (url.href !== window.location.href) window.history.pushState({ year: selected, type }, '', url);
    };
    try {
      // Fetch the index on each navigation: its revision invalidates album caches,
      // and newly added or removed years never require a website rebuild.
      const index = await fetchJson(`${base}/api/gallery`, controller.signal);
      if (!validIndex(index)) throw new Error('Invalid gallery index');
      if (!current()) return;
      hadLiveData.current = true;
      setHasLiveData(true); setOffline(false);
      if (liveRevision.current !== index.revision) {
        liveRevision.current = index.revision;
        liveCache.current.clear();
      }
      setCollection(index);
      const selected = chooseYear(yearsFor(index, type), requestedYear, preferredYear);
      setYear(selected); remember(selected);
      if (selected === null) {
        setItems([]); displayedYear.current = null;
        return;
      }
      if (displayedYear.current !== selected) setItems([]);
      let album = liveCache.current.get(selected);
      if (!album) {
        const value = await fetchJson(`${base}/api/gallery/years/${selected}`, controller.signal);
        if (!validAlbum(value)) throw new Error('Invalid gallery album');
        album = value;
      }
      if (!current()) return;
      liveCache.current.set(selected, album);
      displayedYear.current = selected;
      setItems(album);
    } catch {
      if (!current()) return;
      setOffline(true);
      if (hadLiveData.current) {
        // Never resurrect a deleted/unpublished item from the old build after
        // the live collection has become authoritative.
        setError(true);
        if (requestedYear !== undefined && displayedYear.current !== requestedYear) setItems([]);
        return;
      }
      // Retain the original gallery during first-time setup or an outage, with
      // an explicit notice so a saved snapshot cannot masquerade as live data.
      setCollection(snapshot.current);
      const selected = chooseYear(yearsFor(snapshot.current, type), requestedYear, preferredYear);
      setYear(selected); remember(selected);
      if (selected === null) { setItems([]); displayedYear.current = null; return; }
      try {
        let album = snapshotCache.current.get(selected);
        if (!album) {
          const value = await fetchJson(`/gallery/albums/${selected}.json`, controller.signal, false);
          if (!validAlbum(value)) throw new Error('Invalid saved gallery');
          album = value;
        }
        if (!current()) return;
        snapshotCache.current.set(selected, album);
        displayedYear.current = selected;
        setItems(album);
      } catch {
        if (current()) { setItems([]); setError(true); }
      }
    } finally {
      if (current()) { isLoading.current = false; setLoading(false); }
    }
  }, [base, initialType, preferredYear]);

  const readSelection = useCallback((): Selection => {
    const params = new URLSearchParams(window.location.search);
    const rawYear = Number(params.get('year'));
    const rawType = params.get('type');
    return { requestedYear: params.has('year') && Number.isInteger(rawYear) ? rawYear : undefined, type: rawType === 'all' || rawType === 'photos' || rawType === 'videos' ? rawType : initialType };
  }, [initialType]);
  useEffect(() => {
    const restore = () => { void loadSelection(readSelection()); };
    const refresh = () => { if (!isLoading.current && document.visibilityState === 'visible') restore(); };
    restore();
    window.addEventListener('popstate', restore);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      activeRequest.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadSelection, readSelection]);

  const availableYears = yearsFor(collection, mediaType);
  const yearIndex = year === null ? -1 : availableYears.indexOf(year);
  const visible = items.filter(item => mediaType === 'all' || item.kind === (mediaType === 'photos' ? 'photo' : 'video'));
  const photoCount = visible.filter(item => item.kind === 'photo').length;
  const videoCount = visible.filter(item => item.kind === 'video').length;
  const selectYear = (selected: number) => { void loadSelection({ requestedYear: selected, type: mediaType, updateUrl: true }); };
  const selectType = (type: MediaFilter) => { void loadSelection({ requestedYear: year ?? undefined, type, updateUrl: true }); };
  const countLabel = [photoCount ? `${photoCount} photos` : '', videoCount ? `${videoCount} ${videoCount === 1 ? 'video' : 'videos'}` : ''].filter(Boolean).join(' · ');
  return <section className="gallery-page" aria-labelledby="gallery-heading">
    <div className="gallery-topline"><h1 id="gallery-heading">Gallery</h1><p className="gallery-photo-count" aria-live="polite">{loading ? 'Loading…' : countLabel || 'No media'}</p></div>
    {offline && <div className="gallery-connection-status" role="status"><p>{hasLiveData ? 'The gallery could not be refreshed. The last available update is shown.' : 'The live gallery is temporarily unavailable. Showing the saved gallery.'}</p><button type="button" onClick={() => void loadSelection(readSelection())}>Retry live gallery</button></div>}
    <div className="gallery-media-types" role="group" aria-label="Media type">{(['all', 'photos', 'videos'] as const).map(type => <button key={type} type="button" aria-pressed={mediaType === type} onClick={() => selectType(type)}>{type === 'all' ? 'All media' : type === 'photos' ? 'Photos' : 'Videos'}</button>)}</div>
    <div className="gallery-year-navigation" role="group" aria-label="Gallery year">
      <button type="button" aria-label="Previous year" disabled={yearIndex < 0 || yearIndex === availableYears.length - 1} onClick={() => selectYear(availableYears[yearIndex + 1])}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg></button>
      <div className="gallery-year-select"><select aria-label="Select gallery year" value={year ?? ''} disabled={!availableYears.length} onChange={event => selectYear(Number(event.target.value))}>{availableYears.length ? availableYears.map(option => <option key={option} value={option}>{option}</option>) : <option value="">—</option>}</select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></div>
      <button type="button" aria-label="Next year" disabled={yearIndex <= 0} onClick={() => selectYear(availableYears[yearIndex - 1])}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6M16 12H4" /></svg></button>
    </div>
    <noscript><p className="gallery-connection-status">This saved gallery may not include recent updates.</p><nav className="gallery-no-js-years" aria-label="Gallery years">{years.map(available => <a href={`/mmbs-${available}`} key={available}>{available}</a>)}<a href="/videos">Videos</a></nav></noscript>
    {error && <div className="gallery-error" role="alert"><p>This media couldn't be loaded.</p><button type="button" onClick={() => void loadSelection({ requestedYear: year ?? undefined, type: mediaType })}>Try again</button></div>}
    {!loading && !error && !visible.length && <p className="gallery-empty" role="status">{mediaType === 'videos' ? 'No videos have been published yet.' : mediaType === 'photos' ? 'No photos have been published yet.' : 'There are no published photos or videos yet.'}</p>}
    <div className="gallery-mosaic" data-media-type={mediaType} aria-busy={loading} aria-label={year === null ? 'Gallery' : `MMB's ${year}`}>
      {visible.map((item, index) => item.kind === 'video' ? <VideoTile key={item.id || item.src} item={item} /> : <PhotoTile key={item.id || item.src} photo={item} year={year} index={index} />)}
    </div>
  </section>;
}

function VideoTile({ item }: { item: Video }) {
  const [poster, setPoster] = useState(item.placeholder || item.poster);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setPoster(item.placeholder || item.poster); setFailed(false);
    if (item.provider === 'upload' && item.poster) {
      const image = new Image(); image.src = item.poster;
      image.decode().then(() => { if (active) setPoster(item.poster); }).catch(() => {});
    }
    return () => { active = false; };
  }, [item.provider, item.poster, item.placeholder, item.src]);
  return <figure className="mosaic-tile mosaic-video">
    <div className="mosaic-video-player">{item.provider === 'upload'
      ? <video src={item.src} poster={poster} controls playsInline preload="metadata" aria-label={item.title} onError={() => setFailed(true)} />
      : <iframe src={item.src} title={item.title} loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />}</div>
    {failed && <p className="mosaic-video-error" role="alert">This video couldn't be loaded. <a href={item.src} target="_blank" rel="noopener noreferrer">Open video</a></p>}
    <figcaption><span className="mosaic-video-label">Video</span><strong>{item.title}</strong>{item.note && <p className="mosaic-video-note">{item.note}</p>}</figcaption>
  </figure>;
}
function PhotoTile({ photo, year, index }: { photo: Photo; year: number | null; index: number }) {
  return <figure className="mosaic-tile">
    <a href={photo.src} rel={`lightbox[year-${year}]`} title={photo.caption || undefined} aria-label={photo.caption || photo.alt || `Open photo ${index + 1}${year === null ? '' : ` from ${year}`}`}>
      <span key={photo.thumbnail} className="progressive-image" style={{ '--image-placeholder': `url("${photo.placeholder}")` } as CSSProperties}>
        <img src={photo.thumbnail} data-blurhash={photo.hash} width={photo.width} height={photo.height} alt={photo.alt} loading="lazy" decoding="async" />
      </span>
    </a>
    {photo.caption && <figcaption>{photo.caption}</figcaption>}
  </figure>;
}
