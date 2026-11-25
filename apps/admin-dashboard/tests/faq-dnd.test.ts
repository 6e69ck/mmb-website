import { describe, expect, it } from 'vitest';
import { reorderFaqItems } from '../src/pages/FaqEditor';

type SampleFaq = { id: string; question: string };

const makeItems = (): SampleFaq[] => [
  { id: 'q1', question: '1. First?' },
  { id: 'q2', question: '2. Second?' },
  { id: 'q3', question: '3. Third?' },
  { id: 'q4', question: '4. Fourth?' },
];

const ids = (items: SampleFaq[]) => items.map(item => item.id);

describe('reorderFaqItems', () => {
  it('moves an item up before an earlier target', () => {
    const items = makeItems();
    const result = reorderFaqItems(items, 2, 0, 'before');
    expect(ids(result)).toEqual(['q3', 'q1', 'q2', 'q4']);
    expect(ids(items)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('moves an item up after an earlier target', () => {
    const items = makeItems();
    const result = reorderFaqItems(items, 3, 0, 'after');
    expect(ids(result)).toEqual(['q1', 'q4', 'q2', 'q3']);
  });

  it('moves an item down before a later target', () => {
    const items = makeItems();
    const result = reorderFaqItems(items, 0, 2, 'before');
    expect(ids(result)).toEqual(['q2', 'q1', 'q3', 'q4']);
  });

  it('moves an item down after a later target', () => {
    const items = makeItems();
    const result = reorderFaqItems(items, 0, 2, 'after');
    expect(ids(result)).toEqual(['q2', 'q3', 'q1', 'q4']);
  });

  it('moves the last item to the very top', () => {
    const items = makeItems();
    const result = reorderFaqItems(items, 3, 0, 'before');
    expect(ids(result)).toEqual(['q4', 'q1', 'q2', 'q3']);
  });

  it('moves the first item to the very bottom', () => {
    const items = makeItems();
    const result = reorderFaqItems(items, 0, 3, 'after');
    expect(ids(result)).toEqual(['q2', 'q3', 'q4', 'q1']);
  });

  it('supports adjacent one-step moves (up and down)', () => {
    const items = makeItems();
    expect(ids(reorderFaqItems(items, 2, 1, 'before'))).toEqual(['q1', 'q3', 'q2', 'q4']);
    expect(ids(reorderFaqItems(items, 1, 2, 'after'))).toEqual(['q1', 'q3', 'q2', 'q4']);
  });

  it('treats dropping on the same item as a no-op', () => {
    const items = makeItems();
    expect(reorderFaqItems(items, 1, 1, 'before')).toBe(items);
    expect(reorderFaqItems(items, 1, 1, 'after')).toBe(items);
  });

  it('treats adjacent no-op placements as unchanged', () => {
    const items = makeItems();
    // q2 (index 1) is already immediately after q1 (index 0)
    expect(reorderFaqItems(items, 1, 0, 'after')).toBe(items);
    // q2 (index 1) is already immediately before q3 (index 2)
    expect(reorderFaqItems(items, 1, 2, 'before')).toBe(items);
  });

  it('handles out-of-bounds, empty, and single-item lists safely as no-ops', () => {
    const items = makeItems();
    expect(reorderFaqItems(items, -1, 1, 'before')).toBe(items);
    expect(reorderFaqItems(items, 0, 4, 'after')).toBe(items);
    expect(reorderFaqItems(items, 4, 0, 'before')).toBe(items);
    expect(reorderFaqItems(items, 1, -1, 'after')).toBe(items);

    const empty: SampleFaq[] = [];
    expect(reorderFaqItems(empty, 0, 0, 'before')).toBe(empty);

    const single = [items[0]];
    expect(reorderFaqItems(single, 0, 0, 'after')).toBe(single);
  });
});
