import { useEffect, useRef, useState } from 'react';

type Photo = { src: string; alt: string; hash: string; placeholder: string };
export default function ImageExperience() {
  const [gallery, setGallery] = useState<Photo[]>([]);
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const a = (event.target as Element).closest<HTMLAnchorElement>('a[rel^="lightbox"], .wsite-image a[href]');
      if (!a || !/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(a.href)) return;
      event.preventDefault();
      const group = a.getAttribute('rel');
      const links = group ? [...document.querySelectorAll<HTMLAnchorElement>('a[rel^="lightbox"]')].filter(el => el.getAttribute('rel') === group) : [a];
      setGallery(links.map(el => { const img = el.querySelector('img'); return { src: el.href, alt: el.getAttribute('title') || img?.alt || '', hash: img?.dataset.blurhash || '', placeholder: img?.currentSrc || '' }; }));
      setIndex(Math.max(0, links.indexOf(a))); setReady(false);
      trigger.current = a;
    };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, []);
  useEffect(() => {
    if (!gallery.length) return;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); setIndex(i => (i + 1) % gallery.length); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(i => (i - 1 + gallery.length) % gallery.length); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = bodyOverflow; document.removeEventListener('keydown', key); trigger.current?.focus(); };
  }, [gallery]);
  useEffect(() => {
    setReady(false);
    const id = ++request.current;
    if (!gallery[index]) return;
    const image = new Image(); image.src = gallery[index].src;
    image.decode().then(() => { if (request.current === id) setReady(true); }).catch(() => {});
  }, [index, gallery]);
  const close = () => { dialog.current?.close(); setGallery([]); };
  if (!gallery.length) return null;
  const photo = gallery[index];
  return <dialog ref={dialog} className="photo-dialog" aria-label="Gallery" onCancel={() => setGallery([])} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <button type="button" className="photo-close" aria-label="Close" onClick={close}>×</button>
    <figure>
      <img src={ready ? photo.src : photo.placeholder} data-blurhash={photo.hash} alt={photo.alt} className={ready ? 'photo-ready' : ''} />
      {photo.alt && <figcaption>{photo.alt}</figcaption>}
    </figure>
    {gallery.length > 1 && <><button type="button" className="photo-prev" aria-label="Previous image" onClick={() => setIndex((index - 1 + gallery.length) % gallery.length)}>‹</button><button type="button" className="photo-next" aria-label="Next image" onClick={() => setIndex((index + 1) % gallery.length)}>›</button><span className="photo-count" aria-live="polite">{index + 1} / {gallery.length}</span></>}
  </dialog>;
}
