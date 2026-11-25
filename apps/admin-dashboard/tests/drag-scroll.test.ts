import { describe, expect, it } from 'vitest';
import { computeEdgeScrollDelta } from '../src/pages/useDragAutoScroll';
import { reorderBlocks } from '../src/pages/BlockComposer';

describe('computeEdgeScrollDelta', () => {
  it('scrolls down when pointer is within the bottom 50px of the viewport', () => {
    const atThreshold = computeEdgeScrollDelta(750, 800);
    const deeper = computeEdgeScrollDelta(780, 800);
    const atEdge = computeEdgeScrollDelta(800, 800);

    expect(atThreshold).toBeGreaterThanOrEqual(2);
    expect(atThreshold).toBeLessThanOrEqual(18);
    expect(deeper).toBeGreaterThan(atThreshold);
    expect(atEdge).toBeGreaterThan(deeper);
    expect(atEdge).toBe(18);
  });

  it('clamps bottom scroll delta to maxStep even past viewport bottom', () => {
    expect(computeEdgeScrollDelta(840, 800, 50, 18)).toBe(18);
    expect(computeEdgeScrollDelta(799, 800, 50, 12)).toBeLessThanOrEqual(12);
    expect(computeEdgeScrollDelta(750, 800, 50, 12)).toBe(2);
  });

  it('scrolls up when pointer is within the top 50px of the viewport', () => {
    const atThreshold = computeEdgeScrollDelta(50, 800);
    const deeper = computeEdgeScrollDelta(20, 800);
    const atTop = computeEdgeScrollDelta(0, 800);

    expect(atThreshold).toBeLessThanOrEqual(-2);
    expect(atThreshold).toBeGreaterThanOrEqual(-18);
    expect(deeper).toBeLessThan(atThreshold);
    expect(atTop).toBeLessThan(deeper);
    expect(atTop).toBe(-18);
  });

  it('clamps top scroll delta to -maxStep even above viewport top', () => {
    expect(computeEdgeScrollDelta(-25, 800, 50, 18)).toBe(-18);
  });

  it('returns 0 in the middle of the viewport outside both edge zones', () => {
    expect(computeEdgeScrollDelta(51, 800)).toBe(0);
    expect(computeEdgeScrollDelta(400, 800)).toBe(0);
    expect(computeEdgeScrollDelta(749, 800)).toBe(0);
  });

  it('returns 0 for invalid viewport heights or non-positive parameters', () => {
    expect(computeEdgeScrollDelta(10, 0)).toBe(0);
    expect(computeEdgeScrollDelta(10, -100)).toBe(0);
    expect(computeEdgeScrollDelta(10, Number.NaN)).toBe(0);
    expect(computeEdgeScrollDelta(Number.NaN, 800)).toBe(0);
    expect(computeEdgeScrollDelta(10, 800, 0)).toBe(0);
    expect(computeEdgeScrollDelta(10, 800, 50, 0)).toBe(0);
  });
});

describe('reorderBlocks', () => {
  it('moves a block downward before or after a target block', () => {
    expect(reorderBlocks(['a', 'b', 'c', 'd'], 0, 2, 'before')).toEqual(['b', 'a', 'c', 'd']);
    expect(reorderBlocks(['a', 'b', 'c', 'd'], 0, 2, 'after')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a block upward before or after a target block', () => {
    expect(reorderBlocks(['a', 'b', 'c', 'd'], 3, 1, 'before')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderBlocks(['a', 'b', 'c', 'd'], 3, 1, 'after')).toEqual(['a', 'b', 'd', 'c']);
  });

  it('returns the original array reference for no-op drops', () => {
    const items = ['a', 'b', 'c'];
    expect(reorderBlocks(items, 1, 1, 'before')).toBe(items);
    expect(reorderBlocks(items, 1, 1, 'after')).toBe(items);
    expect(reorderBlocks(items, 1, 0, 'after')).toBe(items);
    expect(reorderBlocks(items, 1, 2, 'before')).toBe(items);
  });
});
