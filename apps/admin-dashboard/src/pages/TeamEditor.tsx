import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  newBlockId,
  type ContentImage,
  type PageBlock,
  type SectionBackground,
  type TeamGroupBlock,
  type TeamMember,
} from '@mmb/content';
import { uploadContentAsset } from '../api';
import { processPhoto } from '../media-processing';
import { Icon } from '../ui';
import { resolveImageUrl, type AdminMode } from './asset-urls';
import RichTextEditor from './RichTextEditor';
import { useDragAutoScroll } from './useDragAutoScroll';
import './team-editor.css';

type DragPayload = {
  groupId: string;
  memberId: string;
  index: number;
};

type DropIndicator =
  | { type: 'card'; groupId: string; memberId: string; position: 'before' | 'after'; insertIndex: number }
  | { type: 'section-end'; groupId: string; insertIndex: number };

/**
 * Pure helper to move a team member within the same `team-group` block
 * or across two different `team-group` blocks (including into an empty section).
 *
 * `toIndex` is an insertion slot index in the target section (`0..target.members.length`):
 * - Dropping before card `i` uses `toIndex = i`
 * - Dropping after card `i` uses `toIndex = i + 1`
 * - Dropping at the end of a section (or into an empty section) uses `toIndex = target.members.length`
 *
 * When moving downward within the same section (`toIndex > fromIndex`), `toIndex` is
 * adjusted by `-1` after removing the source item so the person lands at the exact drop indicator.
 * All non-`team-group` blocks and all member fields are preserved immutably.
 */
export function moveTeamMember(
  blocks: PageBlock[],
  fromGroupId: string,
  fromIndex: number,
  toGroupId: string,
  toIndex: number
): PageBlock[] {
  const sourceBlock = blocks.find(
    (block): block is TeamGroupBlock => block.type === 'team-group' && block.id === fromGroupId
  );
  const targetBlock = blocks.find(
    (block): block is TeamGroupBlock => block.type === 'team-group' && block.id === toGroupId
  );

  if (!sourceBlock || !targetBlock) return blocks;
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= sourceBlock.members.length) {
    return blocks;
  }

  const clampedTo = Math.max(0, Math.min(Math.trunc(toIndex), targetBlock.members.length));

  if (fromGroupId === toGroupId) {
    if (clampedTo === fromIndex || clampedTo === fromIndex + 1) {
      return blocks;
    }
    const insertAt = clampedTo > fromIndex ? clampedTo - 1 : clampedTo;
    const nextMembers = [...sourceBlock.members];
    const [moved] = nextMembers.splice(fromIndex, 1);
    nextMembers.splice(insertAt, 0, moved);
    return blocks.map(block =>
      block.type === 'team-group' && block.id === fromGroupId ? { ...block, members: nextMembers } : block
    );
  }

  const nextSourceMembers = [...sourceBlock.members];
  const [moved] = nextSourceMembers.splice(fromIndex, 1);
  const nextTargetMembers = [...targetBlock.members];
  nextTargetMembers.splice(clampedTo, 0, moved);

  return blocks.map(block => {
    if (block.type !== 'team-group') return block;
    if (block.id === fromGroupId) return { ...block, members: nextSourceMembers };
    if (block.id === toGroupId) return { ...block, members: nextTargetMembers };
    return block;
  });
}

/**
 * Pure helper to swap a `team-group` section up or down relative to other `team-group` blocks,
 * leaving any non-`team-group` blocks in their existing positions.
 */
export function reorderTeamGroups(
  blocks: PageBlock[],
  groupId: string,
  direction: 'up' | 'down'
): PageBlock[] {
  const groupIndices: number[] = [];
  blocks.forEach((block, index) => {
    if (block.type === 'team-group') groupIndices.push(index);
  });
  const pos = groupIndices.findIndex(index => blocks[index].id === groupId);
  if (pos === -1) return blocks;
  const targetPos = direction === 'up' ? pos - 1 : pos + 1;
  if (targetPos < 0 || targetPos >= groupIndices.length) return blocks;

  const copy = [...blocks];
  const fromBlockIndex = groupIndices[pos];
  const toBlockIndex = groupIndices[targetPos];
  [copy[fromBlockIndex], copy[toBlockIndex]] = [copy[toBlockIndex], copy[fromBlockIndex]];
  return copy;
}

function SilhouetteIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}

function MemberPortraitUploader({
  photo,
  memberName,
  mode,
  onChange,
}: {
  photo?: ContentImage;
  memberName: string;
  mode: AdminMode;
  onChange: (next?: ContentImage) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const src = resolveImageUrl(photo, mode);

  async function handleFile(file: File) {
    setBusy(true);
    setError('');
    const controller = new AbortController();
    try {
      const processed = await processPhoto(file, controller.signal);
      const uploaded = await uploadContentAsset(file, controller.signal);
      onChange({
        assetKey: uploaded.assetKey,
        alt: photo?.alt || memberName.trim() || file.name.replace(/\.[^.]+$/, ''),
        width: processed.width,
        height: processed.height,
        hash: processed.hash,
        placeholder: processed.placeholder,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload portrait.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="team-portrait-uploader">
      <div className="team-portrait-preview">
        {src ? (
          <a href={src} target="_blank" rel="noopener noreferrer" title="Open full image">
            <img src={src} alt={photo?.alt || memberName || 'Member portrait'} />
          </a>
        ) : (
          <div className="team-portrait-placeholder">
            <SilhouetteIcon size={32} />
            <span>Silhouette</span>
          </div>
        )}
      </div>
      <div className="team-portrait-controls">
        <label className="button button-secondary button-sm file-picker">
          <Icon name="upload" size={14} />
          <span>{busy ? 'Uploading…' : src ? 'Replace photo' : 'Upload photo'}</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            disabled={busy}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </label>
        {src && (
          <a className="text-button team-portrait-link" href={src} target="_blank" rel="noopener noreferrer">
            <Icon name="arrow" size={13} /> View full image
          </a>
        )}
        {src && (
          <button
            type="button"
            className="text-button team-portrait-link"
            onClick={() => onChange(undefined)}
            disabled={busy}
          >
            Use silhouette placeholder
          </button>
        )}
        {error && <span className="inline-error">{error}</span>}
      </div>
    </div>
  );
}

export default function TeamEditor({
  blocks,
  mode,
  onChange,
  rearrangeMode = false,
}: {
  blocks: PageBlock[];
  mode: AdminMode;
  onChange: (next: PageBlock[]) => void;
  rearrangeMode?: boolean;
}) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const draggingRef = useRef<DragPayload | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const dropIndicatorRef = useRef<DropIndicator | null>(null);
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null);

  const setDropIndicatorSynced = (next: DropIndicator | null) => {
    dropIndicatorRef.current = next;
    setDropIndicator(next);
  };

  useDragAutoScroll(rearrangeMode && dragging !== null);

  useEffect(() => {
    if (!rearrangeMode) {
      draggingRef.current = null;
      setDragging(null);
      setDropIndicatorSynced(null);
    }
  }, [rearrangeMode]);

  const teamGroups = blocks.filter((block): block is TeamGroupBlock => block.type === 'team-group');
  const otherBlockCount = blocks.length - teamGroups.length;
  const totalMembers = teamGroups.reduce((sum, group) => sum + group.members.length, 0);

  const updateGroup = (groupId: string, updater: (group: TeamGroupBlock) => TeamGroupBlock) => {
    onChange(
      blocks.map(block => (block.type === 'team-group' && block.id === groupId ? updater(block) : block))
    );
  };

  const addSection = () => {
    const nextGroup: TeamGroupBlock = {
      id: newBlockId(),
      type: 'team-group',
      heading: teamGroups.length === 0 ? 'Executives' : 'New Team Section',
      layout: teamGroups.length === 0 ? 'executives' : 'leaders',
      background: teamGroups.length % 2 === 1 ? 'gray' : 'white',
      members: [],
    };
    onChange([...blocks, nextGroup]);
  };

  const removeSection = (groupId: string) => {
    setConfirmDeleteGroupId(null);
    onChange(blocks.filter(block => block.id !== groupId));
  };

  const addPerson = (groupId: string) => {
    const newMember: TeamMember = {
      id: newBlockId(),
      name: 'New Member',
      role: 'Role',
      bio: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    };
    updateGroup(groupId, group => ({
      ...group,
      members: [...group.members, newMember],
    }));
    setExpandedIds(prev => ({ ...prev, [newMember.id]: true }));
  };

  const updateMember = (groupId: string, memberId: string, patch: Partial<TeamMember>) => {
    updateGroup(groupId, group => ({
      ...group,
      members: group.members.map(member => (member.id === memberId ? { ...member, ...patch } : member)),
    }));
  };

  const removeMember = (groupId: string, memberId: string) => {
    updateGroup(groupId, group => ({
      ...group,
      members: group.members.filter(member => member.id !== memberId),
    }));
    setExpandedIds(prev => {
      if (!(memberId in prev)) return prev;
      const next = { ...prev };
      delete next[memberId];
      return next;
    });
  };

  const toggleExpand = (memberId: string) => {
    setExpandedIds(prev => ({ ...prev, [memberId]: !prev[memberId] }));
  };

  const setAllExpanded = (expanded: boolean) => {
    if (!expanded) {
      setExpandedIds({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const group of teamGroups) {
      for (const member of group.members) {
        next[member.id] = true;
      }
    }
    setExpandedIds(next);
  };

  const clearDragState = () => {
    draggingRef.current = null;
    setDragging(null);
    setDropIndicatorSynced(null);
  };

  const startDrag = (event: DragEvent<HTMLElement>, groupId: string, memberId: string, index: number) => {
    if (!rearrangeMode) {
      event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [contenteditable="true"]')) {
      event.preventDefault();
      return;
    }
    const payload: DragPayload = { groupId, memberId, index };
    draggingRef.current = payload;
    setDragging(payload);
    setDropIndicatorSynced(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(payload));

    const card = event.currentTarget.closest('.team-person-card');
    if (card instanceof HTMLElement && typeof event.dataTransfer.setDragImage === 'function') {
      event.dataTransfer.setDragImage(card, 24, 24);
    }
  };

  const isNoOpDrop = (drag: DragPayload, targetGroupId: string, insertIndex: number): boolean =>
    drag.groupId === targetGroupId && (insertIndex === drag.index || insertIndex === drag.index + 1);

  const handleCardDragOver = (
    event: DragEvent<HTMLElement>,
    groupId: string,
    memberId: string,
    index: number
  ) => {
    if (!rearrangeMode) return;
    const drag = draggingRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const insertIndex = position === 'before' ? index : index + 1;

    if (isNoOpDrop(drag, groupId, insertIndex)) {
      setDropIndicatorSynced(null);
      return;
    }

    const prev = dropIndicatorRef.current;
    if (
      prev &&
      prev.type === 'card' &&
      prev.groupId === groupId &&
      prev.memberId === memberId &&
      prev.position === position
    ) {
      return;
    }
    setDropIndicatorSynced({ type: 'card', groupId, memberId, position, insertIndex });
  };

  const handleCardDrop = (event: DragEvent<HTMLElement>, groupId: string, index: number) => {
    if (!rearrangeMode) return;
    const drag = draggingRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = event.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const insertIndex = position === 'before' ? index : index + 1;

    if (!isNoOpDrop(drag, groupId, insertIndex)) {
      onChange(moveTeamMember(blocks, drag.groupId, drag.index, groupId, insertIndex));
    }
    clearDragState();
  };

  const handleListDragOver = (event: DragEvent<HTMLElement>, group: TeamGroupBlock) => {
    if (!rearrangeMode) return;
    const drag = draggingRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    // Preserve active drop indicator within this section while hovering the 8px gap between cards
    const current = dropIndicatorRef.current;
    if (current && current.groupId === group.id) {
      return;
    }

    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(':scope > .team-person-card'));
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        const member = group.members[i];
        if (member && !isNoOpDrop(drag, group.id, i)) {
          setDropIndicatorSynced({
            type: 'card',
            groupId: group.id,
            memberId: member.id,
            position: 'before',
            insertIndex: i,
          });
        } else {
          setDropIndicatorSynced(null);
        }
        return;
      }
    }

    const endIndex = group.members.length;
    if (isNoOpDrop(drag, group.id, endIndex)) {
      setDropIndicatorSynced(null);
    } else {
      setDropIndicatorSynced({ type: 'section-end', groupId: group.id, insertIndex: endIndex });
    }
  };

  const handleListDrop = (event: DragEvent<HTMLElement>, group: TeamGroupBlock) => {
    if (!rearrangeMode) return;
    const drag = draggingRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();

    const current = dropIndicatorRef.current;
    if (current && current.groupId === group.id) {
      if (!isNoOpDrop(drag, group.id, current.insertIndex)) {
        onChange(moveTeamMember(blocks, drag.groupId, drag.index, group.id, current.insertIndex));
      }
      clearDragState();
      return;
    }

    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(':scope > .team-person-card'));
    let insertIndex = group.members.length;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        insertIndex = i;
        break;
      }
    }
    if (!isNoOpDrop(drag, group.id, insertIndex)) {
      onChange(moveTeamMember(blocks, drag.groupId, drag.index, group.id, insertIndex));
    }
    clearDragState();
  };

  const handleSectionEndDragOver = (event: DragEvent<HTMLElement>, group: TeamGroupBlock) => {
    if (!rearrangeMode) return;
    const drag = draggingRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const insertIndex = group.members.length;
    if (isNoOpDrop(drag, group.id, insertIndex)) {
      setDropIndicatorSynced(null);
      return;
    }

    const prev = dropIndicatorRef.current;
    if (prev && prev.type === 'section-end' && prev.groupId === group.id) return;
    setDropIndicatorSynced({ type: 'section-end', groupId: group.id, insertIndex });
  };

  const handleSectionEndDrop = (event: DragEvent<HTMLElement>, group: TeamGroupBlock) => {
    if (!rearrangeMode) return;
    const drag = draggingRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();

    const insertIndex = group.members.length;
    if (!isNoOpDrop(drag, group.id, insertIndex)) {
      onChange(moveTeamMember(blocks, drag.groupId, drag.index, group.id, insertIndex));
    }
    clearDragState();
  };

  return (
    <div
      className={[
        'team-editor-root',
        rearrangeMode ? 'is-rearrange-mode' : 'is-edit-mode',
        rearrangeMode && dragging ? 'is-dragging-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="team-editor-toolbar">
        <div className="team-editor-summary">
          <strong>
            {rearrangeMode ? 'Rearrange team' : `${teamGroups.length} ${teamGroups.length === 1 ? 'section' : 'sections'} · ${totalMembers} ${totalMembers === 1 ? 'person' : 'people'}`}
          </strong>
        </div>
        {!rearrangeMode && (
          <div className="team-editor-toolbar-actions">
            {totalMembers > 0 && (
              <>
                <button type="button" className="button button-secondary button-sm" onClick={() => setAllExpanded(true)}>
                  Expand all
                </button>
                <button type="button" className="button button-secondary button-sm" onClick={() => setAllExpanded(false)}>
                  Collapse all
                </button>
              </>
            )}
            <button type="button" className="button button-primary button-sm" onClick={addSection}>
              <Icon name="plus" size={14} /> Add team section
            </button>
          </div>
        )}
      </div>

      {otherBlockCount > 0 && (
        <div className="team-preserved-note" role="status">
          {otherBlockCount} additional non-team {otherBlockCount === 1 ? 'block' : 'blocks'} on this page{' '}
          {otherBlockCount === 1 ? 'is' : 'are'} preserved automatically when publishing.
        </div>
      )}

      {teamGroups.length === 0 ? (
        <div className="team-empty-canvas">
          <div className="empty-state-icon">
            <Icon name="users" size={26} />
          </div>
          <h3>No team sections yet</h3>
          <p>Create a section such as Executives or Section Leaders, then add team members.</p>
          <button type="button" className="button button-primary" onClick={addSection}>
            <Icon name="plus" size={15} /> Add first team section
          </button>
        </div>
      ) : (
        <div className="team-sections-stack">
          {teamGroups.map((group, groupPos) => {
            const isSectionDropTarget = rearrangeMode && dropIndicator?.groupId === group.id;
            const isEndDropActive =
              rearrangeMode &&
              dropIndicator?.type === 'section-end' &&
              dropIndicator.groupId === group.id;
            const otherGroups = teamGroups.filter(other => other.id !== group.id);
            const isConfirmingDelete = confirmDeleteGroupId === group.id;

            return (
              <section
                key={group.id}
                className={`team-section-card ${isSectionDropTarget ? 'is-section-drop-target' : ''}`}
                aria-label={`${group.heading || 'Team'} section`}
                onDragOver={rearrangeMode ? e => handleSectionEndDragOver(e, group) : undefined}
                onDrop={rearrangeMode ? e => handleSectionEndDrop(e, group) : undefined}
              >
                {rearrangeMode ? (
                  <header className="team-section-header team-section-header-compact">
                    <div className="team-section-heading-row">
                      <div className="team-section-rearrange-title">
                        <h2>{group.heading || 'Untitled section'}</h2>
                        <span className="team-section-count">
                          {group.members.length} {group.members.length === 1 ? 'person' : 'people'}
                        </span>
                      </div>
                      <div className="team-section-buttons">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Move section up"
                          title="Move section up"
                          disabled={groupPos === 0}
                          onClick={() => onChange(reorderTeamGroups(blocks, group.id, 'up'))}
                        >
                          <Icon name="up" size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Move section down"
                          title="Move section down"
                          disabled={groupPos === teamGroups.length - 1}
                          onClick={() => onChange(reorderTeamGroups(blocks, group.id, 'down'))}
                        >
                          <Icon name="down" size={16} />
                        </button>
                      </div>
                    </div>
                  </header>
                ) : (
                  <header className="team-section-header">
                    <div className="team-section-heading-row">
                      <label className="team-section-heading-field">
                        <span className="team-sr-label">Section heading</span>
                        <input
                          className="team-section-heading-input"
                          value={group.heading}
                          maxLength={160}
                          placeholder="Section heading (e.g. Executives)"
                          onChange={e => updateGroup(group.id, prev => ({ ...prev, heading: e.target.value }))}
                        />
                      </label>
                      <span className="team-section-count">
                        {group.members.length} {group.members.length === 1 ? 'person' : 'people'}
                      </span>
                    </div>

                    <div className="team-section-controls">
                      <label className="team-inline-select">
                        <span>Layout</span>
                        <select
                          aria-label={`${group.heading || 'Section'} layout`}
                          value={group.layout}
                          onChange={e =>
                            updateGroup(group.id, prev => ({
                              ...prev,
                              layout: e.target.value === 'leaders' ? 'leaders' : 'executives',
                            }))
                          }
                        >
                          <option value="executives">Executives (auto-fit)</option>
                          <option value="leaders">Section Leaders (2×2)</option>
                        </select>
                      </label>

                      <label className="team-inline-select">
                        <span>Background</span>
                        <select
                          aria-label={`${group.heading || 'Section'} background`}
                          value={group.background || 'white'}
                          onChange={e =>
                            updateGroup(group.id, prev => ({
                              ...prev,
                              background: (e.target.value === 'gray' ? 'gray' : 'white') as SectionBackground,
                            }))
                          }
                        >
                          <option value="white">White</option>
                          <option value="gray">Gray</option>
                        </select>
                      </label>

                      <div className="team-section-buttons">
                        <button
                          type="button"
                          className="button button-primary button-sm"
                          onClick={() => addPerson(group.id)}
                        >
                          <Icon name="plus" size={14} /> Add person
                        </button>
                        {isConfirmingDelete ? (
                          <div className="team-delete-confirm" role="group" aria-label="Confirm section removal">
                            <button
                              type="button"
                              className="button button-danger button-sm"
                              onClick={() => removeSection(group.id)}
                            >
                              Remove
                            </button>
                            <button
                              type="button"
                              className="button button-secondary button-sm"
                              onClick={() => setConfirmDeleteGroupId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="icon-button danger"
                            aria-label={`Remove ${group.heading || 'team'} section`}
                            title="Remove section"
                            onClick={() => {
                              if (group.members.length === 0) {
                                removeSection(group.id);
                              } else {
                                setConfirmDeleteGroupId(group.id);
                              }
                            }}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  </header>
                )}

                <div className="team-section-body">
                  {group.members.length === 0 ? (
                    rearrangeMode ? (
                      <div
                        className={`team-empty-drop-zone ${isEndDropActive ? 'is-drop-active' : ''}`}
                        onDragOver={e => handleSectionEndDragOver(e, group)}
                        onDrop={e => handleSectionEndDrop(e, group)}
                      >
                        <p>
                          {isEndDropActive
                            ? `Drop here to move into ${group.heading || 'this section'}`
                            : 'Empty section — drag any person card here.'}
                        </p>
                      </div>
                    ) : (
                      <div className="team-empty-note">
                        <p>No people in this section yet. Click “Add person” above to create a card.</p>
                      </div>
                    )
                  ) : (
                    <>
                      <div
                        className="team-people-list"
                        onDragOver={rearrangeMode ? e => handleListDragOver(e, group) : undefined}
                        onDrop={rearrangeMode ? e => handleListDrop(e, group) : undefined}
                      >
                        {group.members.map((member, idx) => {
                          const isExpanded = !rearrangeMode && Boolean(expandedIds[member.id]);
                          const thumbSrc = resolveImageUrl(member.photo, mode);
                          const isBeingDragged =
                            rearrangeMode &&
                            dragging?.groupId === group.id &&
                            dragging.memberId === member.id;
                          const isDropBefore =
                            rearrangeMode &&
                            dropIndicator?.type === 'card' &&
                            dropIndicator.groupId === group.id &&
                            dropIndicator.memberId === member.id &&
                            dropIndicator.position === 'before';
                          const isDropAfter =
                            rearrangeMode &&
                            dropIndicator?.type === 'card' &&
                            dropIndicator.groupId === group.id &&
                            dropIndicator.memberId === member.id &&
                            dropIndicator.position === 'after';

                          const displayName = member.name.trim() || 'Unnamed Member';
                          const displayRole = member.role.trim();

                          return (
                            <article
                              key={member.id}
                              className={[
                                'team-person-card',
                                isExpanded ? 'is-expanded' : 'is-compact',
                                isBeingDragged ? 'is-dragging' : '',
                                isDropBefore ? 'is-drop-before' : '',
                                isDropAfter ? 'is-drop-after' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              onDragOver={rearrangeMode ? e => handleCardDragOver(e, group.id, member.id, idx) : undefined}
                              onDrop={rearrangeMode ? e => handleCardDrop(e, group.id, idx) : undefined}
                            >
                              <div className="team-person-head">
                                {rearrangeMode ? (
                                  <div
                                    className="team-person-drag-zone"
                                    draggable
                                    onDragStart={e => startDrag(e, group.id, member.id, idx)}
                                    onDragEnd={clearDragState}
                                    title="Drag to reorder or move to another section"
                                  >
                                    <span className="team-drag-handle" aria-hidden="true">
                                      <Icon name="grip" size={16} />
                                    </span>

                                    <div className="team-person-thumb">
                                      {thumbSrc ? (
                                        <img src={thumbSrc} alt={member.photo?.alt || displayName} />
                                      ) : (
                                        <span className="team-thumb-silhouette" aria-hidden="true">
                                          <SilhouetteIcon size={20} />
                                        </span>
                                      )}
                                    </div>

                                    <div className="team-person-summary">
                                      <div className="team-person-title-line">
                                        <strong className="team-person-name">{displayName}</strong>
                                        {member.pronouns && (
                                          <span className="team-person-pronouns">{member.pronouns}</span>
                                        )}
                                      </div>
                                      <div className="team-person-meta-line">
                                        {displayRole && <span className="team-person-role">{displayRole}</span>}
                                        {member.program && (
                                          <span className="team-person-program">· {member.program}</span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    className="team-person-info-toggle"
                                    aria-expanded={isExpanded}
                                    onClick={() => toggleExpand(member.id)}
                                  >
                                    <div className="team-person-thumb">
                                      {thumbSrc ? (
                                        <img src={thumbSrc} alt={member.photo?.alt || displayName} />
                                      ) : (
                                        <span className="team-thumb-silhouette" aria-hidden="true">
                                          <SilhouetteIcon size={20} />
                                        </span>
                                      )}
                                    </div>

                                    <div className="team-person-summary">
                                      <div className="team-person-title-line">
                                        <strong className="team-person-name">{displayName}</strong>
                                        {member.pronouns && (
                                          <span className="team-person-pronouns">{member.pronouns}</span>
                                        )}
                                      </div>
                                      <div className="team-person-meta-line">
                                        {displayRole && <span className="team-person-role">{displayRole}</span>}
                                        {member.program && (
                                          <span className="team-person-program">· {member.program}</span>
                                        )}
                                      </div>
                                    </div>
                                  </button>
                                )}

                                <div className="team-person-actions">
                                  {rearrangeMode ? (
                                    <>
                                      {otherGroups.length > 0 && (
                                        <select
                                          className="team-move-section-select"
                                          aria-label={`Move ${displayName} to another section`}
                                          value=""
                                          onChange={e => {
                                            const targetId = e.target.value;
                                            if (!targetId) return;
                                            const targetGroup = teamGroups.find(g => g.id === targetId);
                                            if (!targetGroup) return;
                                            onChange(
                                              moveTeamMember(
                                                blocks,
                                                group.id,
                                                idx,
                                                targetId,
                                                targetGroup.members.length
                                              )
                                            );
                                          }}
                                        >
                                          <option value="">Move to section…</option>
                                          {otherGroups.map(target => (
                                            <option key={target.id} value={target.id}>
                                              {target.heading || 'Untitled section'}
                                            </option>
                                          ))}
                                        </select>
                                      )}

                                      <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={`Move ${displayName} up`}
                                        title="Move up"
                                        disabled={idx === 0}
                                        onClick={() =>
                                          onChange(moveTeamMember(blocks, group.id, idx, group.id, idx - 1))
                                        }
                                      >
                                        <Icon name="up" size={15} />
                                      </button>
                                      <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={`Move ${displayName} down`}
                                        title="Move down"
                                        disabled={idx === group.members.length - 1}
                                        onClick={() =>
                                          onChange(moveTeamMember(blocks, group.id, idx, group.id, idx + 2))
                                        }
                                      >
                                        <Icon name="down" size={15} />
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        className="button button-secondary button-sm team-expand-btn"
                                        aria-expanded={isExpanded}
                                        onClick={() => toggleExpand(member.id)}
                                      >
                                        <Icon name={isExpanded ? 'check' : 'edit'} size={13} />
                                        <span>{isExpanded ? 'Done' : 'Edit'}</span>
                                      </button>
                                      <button
                                        type="button"
                                        className="icon-button danger"
                                        aria-label={`Remove ${displayName}`}
                                        title="Remove person"
                                        onClick={() => removeMember(group.id, member.id)}
                                      >
                                        <Icon name="trash" size={15} />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>

                              {isExpanded && (
                                <div className="team-person-body">
                                  <div className="team-person-edit-grid">
                                    <MemberPortraitUploader
                                      photo={member.photo}
                                      memberName={member.name}
                                      mode={mode}
                                      onChange={photo => updateMember(group.id, member.id, { photo })}
                                    />

                                    <div className="team-person-fields">
                                      <div className="field-row">
                                        <label>
                                          <span>Name</span>
                                          <input
                                            value={member.name}
                                            maxLength={120}
                                            placeholder="Full name"
                                            onChange={e =>
                                              updateMember(group.id, member.id, { name: e.target.value })
                                            }
                                          />
                                        </label>
                                        <label>
                                          <span>Pronouns (optional)</span>
                                          <input
                                            value={member.pronouns || ''}
                                            maxLength={60}
                                            placeholder="(she/her)"
                                            onChange={e =>
                                              updateMember(group.id, member.id, {
                                                pronouns: e.target.value || undefined,
                                              })
                                            }
                                          />
                                        </label>
                                      </div>

                                      <div className="field-row">
                                        <label>
                                          <span>Role / Instrument</span>
                                          <input
                                            value={member.role}
                                            maxLength={160}
                                            placeholder="e.g. President or Percussion Leader"
                                            onChange={e =>
                                              updateMember(group.id, member.id, { role: e.target.value })
                                            }
                                          />
                                        </label>
                                        <label>
                                          <span>Program / Year (optional)</span>
                                          <input
                                            value={member.program || ''}
                                            maxLength={160}
                                            placeholder="e.g. Honours Music IV"
                                            onChange={e =>
                                              updateMember(group.id, member.id, {
                                                program: e.target.value || undefined,
                                              })
                                            }
                                          />
                                        </label>
                                      </div>

                                      <div className="team-bio-field">
                                        <span className="field-sub-label">Bio</span>
                                        <RichTextEditor
                                          value={member.bio}
                                          onChange={bio => updateMember(group.id, member.id, { bio })}
                                          minHeight={88}
                                          placeholder="Write member bio…"
                                        />
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>

                      {rearrangeMode && (
                        <div
                          className={`team-end-drop-zone ${isEndDropActive ? 'is-drop-active' : ''}`}
                          onDragOver={e => handleSectionEndDragOver(e, group)}
                          onDrop={e => handleSectionEndDrop(e, group)}
                        >
                          {isEndDropActive
                            ? `Drop here to place at end of ${group.heading || 'section'}`
                            : dragging
                              ? `Drop here to move to end of ${group.heading || 'section'}`
                              : ''}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
