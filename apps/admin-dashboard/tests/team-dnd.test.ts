import { describe, expect, it } from 'vitest';
import type { PageBlock, TeamGroupBlock, TeamMember } from '@mmb/content';
import { moveTeamMember, reorderTeamGroups } from '../src/pages/TeamEditor';

function makeMember(id: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    name: `Member ${id}`,
    pronouns: '(they/them)',
    role: `Role ${id}`,
    program: `Program ${id}`,
    bio: [{ type: 'paragraph', children: [{ type: 'text', text: `Bio for ${id}` }] }],
    photo: {
      legacyPath: `/original/${id}.jpg`,
      alt: `Portrait of ${id}`,
      width: 400,
      height: 400,
    },
    ...overrides,
  };
}

function makeFixture(): PageBlock[] {
  return [
    {
      id: 'intro-heading',
      type: 'heading',
      text: 'Our Team',
      align: 'center',
      background: 'white',
    },
    {
      id: 'team-executives',
      type: 'team-group',
      heading: 'Executives',
      layout: 'executives',
      background: 'white',
      members: [
        makeMember('alice', { name: 'Alice', pronouns: '(she/her)', role: 'President' }),
        makeMember('bob', { name: 'Bob', pronouns: '(he/him)', role: 'Vice President' }),
        makeMember('carol', { name: 'Carol', role: 'Treasurer', program: 'Commerce III' }),
        makeMember('dave', { name: 'Dave', role: 'Secretary', photo: undefined }),
      ],
    },
    {
      id: 'team-leaders',
      type: 'team-group',
      heading: 'Section Leaders',
      layout: 'leaders',
      background: 'gray',
      members: [
        makeMember('perc', { name: 'Percussion Leader', role: 'Percussion', photo: undefined, bio: [] }),
        makeMember('brass', { name: 'Brass Leader', role: 'Brass' }),
      ],
    },
    {
      id: 'team-alumni',
      type: 'team-group',
      heading: 'Alumni Advisors',
      layout: 'leaders',
      background: 'white',
      members: [],
    },
  ];
}

function getGroup(blocks: PageBlock[], id: string): TeamGroupBlock {
  const found = blocks.find((b): b is TeamGroupBlock => b.type === 'team-group' && b.id === id);
  if (!found) throw new Error(`Missing team group ${id}`);
  return found;
}

describe('moveTeamMember', () => {
  it('moves a person upward within the same section', () => {
    const blocks = makeFixture();
    // Move Carol (index 2) before Alice (slot 0)
    const next = moveTeamMember(blocks, 'team-executives', 2, 'team-executives', 0);
    expect(getGroup(next, 'team-executives').members.map(m => m.id)).toEqual([
      'carol',
      'alice',
      'bob',
      'dave',
    ]);
    // Original blocks remain unmutated
    expect(getGroup(blocks, 'team-executives').members.map(m => m.id)).toEqual([
      'alice',
      'bob',
      'carol',
      'dave',
    ]);
  });

  it('moves a person downward within the same section with accurate index adjustment', () => {
    const blocks = makeFixture();
    // Drag Alice (index 0) and drop before Carol (slot 2) -> lands between Bob and Carol (index 1)
    const beforeCarol = moveTeamMember(blocks, 'team-executives', 0, 'team-executives', 2);
    expect(getGroup(beforeCarol, 'team-executives').members.map(m => m.id)).toEqual([
      'bob',
      'alice',
      'carol',
      'dave',
    ]);

    // Drag Alice (index 0) and drop at end of section (slot 4) -> lands at last position
    const toEnd = moveTeamMember(blocks, 'team-executives', 0, 'team-executives', 4);
    expect(getGroup(toEnd, 'team-executives').members.map(m => m.id)).toEqual([
      'bob',
      'carol',
      'dave',
      'alice',
    ]);

    // Move Bob (index 1) down by one step via slot idx + 2 = 3 -> swaps Bob and Carol
    const downOne = moveTeamMember(blocks, 'team-executives', 1, 'team-executives', 3);
    expect(getGroup(downOne, 'team-executives').members.map(m => m.id)).toEqual([
      'alice',
      'carol',
      'bob',
      'dave',
    ]);
  });

  it('transfers a person across sections to a specific target index', () => {
    const blocks = makeFixture();
    // Move Bob (exec index 1) into Section Leaders at index 1 (between perc and brass)
    const next = moveTeamMember(blocks, 'team-executives', 1, 'team-leaders', 1);
    expect(getGroup(next, 'team-executives').members.map(m => m.id)).toEqual(['alice', 'carol', 'dave']);
    expect(getGroup(next, 'team-leaders').members.map(m => m.id)).toEqual(['perc', 'bob', 'brass']);
  });

  it('transfers a person into an empty section', () => {
    const blocks = makeFixture();
    const next = moveTeamMember(blocks, 'team-executives', 0, 'team-alumni', 0);
    expect(getGroup(next, 'team-executives').members.map(m => m.id)).toEqual(['bob', 'carol', 'dave']);
    expect(getGroup(next, 'team-alumni').members.map(m => m.id)).toEqual(['alice']);
  });

  it('preserves every member property and all non-team blocks intact', () => {
    const blocks = makeFixture();
    const originalAlice = getGroup(blocks, 'team-executives').members[0];
    const next = moveTeamMember(blocks, 'team-executives', 0, 'team-leaders', 2);

    const transferred = getGroup(next, 'team-leaders').members[2];
    expect(transferred).toEqual(originalAlice);
    expect(transferred.photo).toEqual({
      legacyPath: '/original/alice.jpg',
      alt: 'Portrait of alice',
      width: 400,
      height: 400,
    });
    expect(transferred.pronouns).toBe('(she/her)');
    expect(transferred.program).toBe('Program alice');
    expect(transferred.bio).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'Bio for alice' }] },
    ]);

    // Non-team-group blocks are preserved in place
    expect(next[0]).toEqual(blocks[0]);
    expect(next).toHaveLength(blocks.length);
  });

  it('treats dropping onto self (before or after) and invalid targets as no-ops', () => {
    const blocks = makeFixture();
    // Dropping Bob (index 1) before Bob (slot 1)
    expect(moveTeamMember(blocks, 'team-executives', 1, 'team-executives', 1)).toBe(blocks);
    // Dropping Bob (index 1) right after Bob (slot 2)
    expect(moveTeamMember(blocks, 'team-executives', 1, 'team-executives', 2)).toBe(blocks);
    // Dropping last item right after itself (slot 4)
    expect(moveTeamMember(blocks, 'team-executives', 3, 'team-executives', 4)).toBe(blocks);
    // Invalid source / target ids or out-of-range source index
    expect(moveTeamMember(blocks, 'missing', 0, 'team-leaders', 0)).toBe(blocks);
    expect(moveTeamMember(blocks, 'team-executives', 0, 'missing', 0)).toBe(blocks);
    expect(moveTeamMember(blocks, 'team-executives', -1, 'team-leaders', 0)).toBe(blocks);
    expect(moveTeamMember(blocks, 'team-executives', 99, 'team-leaders', 0)).toBe(blocks);
  });

  it('clamps out-of-bounds target indices when moving across sections', () => {
    const blocks = makeFixture();
    const toEnd = moveTeamMember(blocks, 'team-executives', 3, 'team-leaders', 50);
    expect(getGroup(toEnd, 'team-leaders').members.map(m => m.id)).toEqual(['perc', 'brass', 'dave']);

    const toStart = moveTeamMember(blocks, 'team-executives', 3, 'team-leaders', -5);
    expect(getGroup(toStart, 'team-leaders').members.map(m => m.id)).toEqual(['dave', 'perc', 'brass']);
  });
});

describe('reorderTeamGroups', () => {
  it('swaps team-group sections while keeping non-team blocks in place', () => {
    const blocks = makeFixture();
    const movedUp = reorderTeamGroups(blocks, 'team-leaders', 'up');
    expect(movedUp.map(b => b.id)).toEqual([
      'intro-heading',
      'team-leaders',
      'team-executives',
      'team-alumni',
    ]);

    const movedDown = reorderTeamGroups(blocks, 'team-leaders', 'down');
    expect(movedDown.map(b => b.id)).toEqual([
      'intro-heading',
      'team-executives',
      'team-alumni',
      'team-leaders',
    ]);

    // Boundary moves are no-ops
    expect(reorderTeamGroups(blocks, 'team-executives', 'up')).toBe(blocks);
    expect(reorderTeamGroups(blocks, 'team-alumni', 'down')).toBe(blocks);
  });
});
