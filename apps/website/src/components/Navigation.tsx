import { useEffect, useRef } from 'react';

type Item = { label: string; href: string; children: Item[] };
const supportsHoverMenus = () => window.matchMedia('(min-width: 1241px) and (hover: hover) and (pointer: fine)').matches;
const cleanHref = (href: string) => href === '/' ? '/' : href.replace(/^(\/[^?#]+)\.html(?=$|[?#])/, '$1');
const cleanTree = (item: Item): Item => ({
  ...item,
  href: item.href ? cleanHref(item.href) : '',
  children: item.children.map(cleanTree),
});

function MenuItem({ item, current, depth }: { item: Item; current: string; depth: number }) {
  const element = useRef<HTMLLIElement>(null);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => {
    if (!item.children.length) return;
    const cancelOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') clearTimers(); };
    // A deliberate click takes precedence over a previously scheduled hover.
    document.addEventListener('pointerdown', clearTimers);
    document.addEventListener('keydown', cancelOnEscape);
    return () => {
      clearTimers();
      document.removeEventListener('pointerdown', clearTimers);
      document.removeEventListener('keydown', cancelOnEscape);
    };
  }, [item.children.length]);
  const normalizedCurrent = cleanHref(current);
  const active = item.href === normalizedCurrent || (item.href === '/gallery' && (['/media', '/videos'].includes(normalizedCurrent) || /^\/mmbs-\d{4}$/.test(normalizedCurrent)));
  return <li ref={element} className={item.children.length ? 'has-submenu' : ''}
    onPointerEnter={event => {
      clearTimers();
      if (event.pointerType === 'touch' || !item.children.length || !supportsHoverMenus() || disclosure.current?.open) return;
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        const branch = element.current;
        if (!branch?.matches(':hover') || !supportsHoverMenus() || !disclosure.current) return;
        const siblings = [...(branch.parentElement?.children || [])].filter(sibling => sibling !== branch);
        // Preserve a keyboard user's active menu rather than hiding its focus.
        if (siblings.some(sibling => sibling.contains(document.activeElement) && document.activeElement?.matches(':focus-visible'))) return;
        for (const sibling of siblings) sibling.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu => { menu.open = false; });
        disclosure.current.open = true;
      }, 200);
    }}
    onPointerLeave={event => {
      clearTimers();
      if (event.pointerType === 'touch' || !disclosure.current?.open || !supportsHoverMenus()) return;
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        const branch = element.current;
        if (!supportsHoverMenus() || branch?.matches(':hover') || branch?.contains(document.activeElement)) return;
        if (disclosure.current) disclosure.current.open = false;
      }, 180);
    }}>
    {!item.href ? <details ref={disclosure} className="submenu-disclosure more-disclosure">
      <summary>{item.label}<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
      <Branch items={item.children} current={current} depth={depth + 1} />
    </details> : <div className="site-menu-link"><a href={item.href} aria-current={active ? 'page' : undefined}>{item.label}</a>
      {item.children.length > 0 && <details ref={disclosure} className="submenu-disclosure">
        <summary aria-label={item.label}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
        <Branch items={item.children} current={current} depth={depth + 1} />
      </details>}
    </div>}
  </li>;
}
function Branch({ items, current, depth = 0 }: { items: Item[]; current: string; depth?: number }) {
  return <ul className={depth ? 'site-submenu' : 'site-menu'}>
    {items.map(item => <MenuItem key={item.href} item={item} current={current} depth={depth} />)}
  </ul>;
}
export default function Navigation({ items, current, logo, width, height }: { items: Item[]; current: string; logo: string; width: number; height: number }) {
  const ref = useRef<HTMLElement>(null);
  const normalizedItems = items.map(cleanTree);
  const normalizedCurrent = cleanHref(current);
  const join = normalizedItems.find(item => item.href === '/join');
  const morePaths = new Set(['/budget', '/constitution', '/executive-meeting-minutes']);
  const primaryOrder = ['/', '/contact', '/faq', '/our-team', '/alumni', '/media', '/about'];
  const menuItems = [
    ...normalizedItems.filter(item => !morePaths.has(item.href) && item.href !== '/join')
      .sort((a, b) => primaryOrder.indexOf(a.href) - primaryOrder.indexOf(b.href))
      .map(item => item.href === '/media' ? { ...item, href: '/gallery', children: [] } : item),
    { label: 'More...', href: '', children: normalizedItems.filter(item => morePaths.has(item.href)) },
  ];
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1241px)');
    const resize = () => { const menu = ref.current?.querySelector<HTMLDetailsElement>('.site-navigation'); if (menu) menu.open = media.matches; };
    resize();
    media.addEventListener('change', resize);
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return;
      ref.current?.querySelectorAll('details[open]').forEach(el => {
        if (el.classList.contains('site-navigation') && media.matches) return;
        el.removeAttribute('open');
        if (event instanceof KeyboardEvent) (el.querySelector('summary') as HTMLElement)?.focus();
      });
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => { media.removeEventListener('change', resize); document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, []);
  return <header className="site-header" ref={ref}>
    <div className="site-header-inner">
      <a className="site-brand" href="/" aria-label="Home"><img src={logo} width={width} height={height} alt="MMB" fetchPriority="high" /></a>
      <details className="site-navigation" open>
        <summary className="menu-toggle" aria-label="Menu"><span /><span /><span /></summary>
        <nav aria-label="Menu"><Branch items={menuItems} current={current} /></nav>
      </details>
      {join && <a className="site-join-button" href={join.href} aria-current={normalizedCurrent === join.href ? 'page' : undefined}>{join.label}</a>}
    </div>
  </header>;
}
