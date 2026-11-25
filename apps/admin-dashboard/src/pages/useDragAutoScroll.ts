import { useEffect, useRef } from 'react';

/**
 * Computes a smooth vertical scroll delta (px/frame) when a dragged pointer
 * approaches the top or bottom edge of the viewport.
 */
export function computeEdgeScrollDelta(
  clientY: number,
  viewportHeight: number,
  edgePx = 50,
  maxStep = 18
): number {
  if (
    !Number.isFinite(clientY) ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0 ||
    edgePx <= 0 ||
    maxStep <= 0
  ) {
    return 0;
  }

  const minStep = Math.min(2, maxStep);
  const bottomStart = viewportHeight - edgePx;

  if (clientY > edgePx && clientY < bottomStart) {
    return 0;
  }

  if (clientY >= bottomStart && clientY >= viewportHeight / 2) {
    const depth = Math.min(edgePx, Math.max(0, clientY - bottomStart));
    const ratio = depth / edgePx;
    const delta = minStep + ratio * (maxStep - minStep);
    return Math.min(maxStep, Math.max(minStep, delta));
  }

  if (clientY <= edgePx) {
    const depth = Math.min(edgePx, Math.max(0, edgePx - clientY));
    const ratio = depth / edgePx;
    const delta = minStep + ratio * (maxStep - minStep);
    return -Math.min(maxStep, Math.max(minStep, delta));
  }

  return 0;
}

/**
 * Smoothly auto-scrolls the window while an HTML5 drag operation is active and
 * the pointer stays within `edgePx` of the top or bottom viewport edge.
 */
export function useDragAutoScroll(active: boolean, edgePx = 50): void {
  const pointerYRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      pointerYRef.current = null;
      return;
    }

    let frameId: number | null = null;
    let cancelled = false;

    const onDragOver = (event: DragEvent) => {
      pointerYRef.current = event.clientY;
    };

    const clearPointer = () => {
      pointerYRef.current = null;
    };

    const tick = () => {
      if (cancelled) return;
      const y = pointerYRef.current;
      if (y !== null) {
        const delta = computeEdgeScrollDelta(y, window.innerHeight, edgePx);
        if (delta !== 0) {
          window.scrollBy(0, delta);
        }
      }
      frameId = window.requestAnimationFrame(tick);
    };

    window.addEventListener('dragover', onDragOver, { capture: true, passive: true });
    window.addEventListener('drop', clearPointer, { capture: true });
    window.addEventListener('dragend', clearPointer, { capture: true });
    frameId = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      pointerYRef.current = null;
      window.removeEventListener('dragover', onDragOver, { capture: true });
      window.removeEventListener('drop', clearPointer, { capture: true });
      window.removeEventListener('dragend', clearPointer, { capture: true });
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [active, edgePx]);
}
