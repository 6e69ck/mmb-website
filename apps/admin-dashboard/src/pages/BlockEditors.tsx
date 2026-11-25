import { useState } from 'react';
import {
  extractDriveFolderId,
  newBlockId,
  type ContentImage,
  type DocumentFileType,
  type DocumentRef,
  type DriveFolderCache,
  type PageBlock,
  type TeamMember,
} from '@mmb/content';
import { api, uploadContentAsset } from '../api';
import { processPhoto } from '../media-processing';
import { Icon } from '../ui';
import { resolveDocumentUrl, resolveImageUrl, type AdminMode } from './asset-urls';
import RichTextEditor from './RichTextEditor';

function inferDocType(filename: string, mime: string): DocumentFileType {
  if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf';
  if (mime.includes('spreadsheetml') || /\.xlsx$/i.test(filename)) return 'xlsx';
  if (mime === 'application/vnd.ms-excel' || /\.xls$/i.test(filename)) return 'xls';
  if (mime === 'text/csv' || /\.csv$/i.test(filename)) return 'csv';
  if (mime.includes('wordprocessingml') || /\.docx$/i.test(filename)) return 'docx';
  return 'pdf';
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

function ImageUploader({
  image,
  mode,
  onChange,
  label = 'Upload image',
  allowClear = false,
}: {
  image?: ContentImage;
  mode: AdminMode;
  onChange: (next?: ContentImage) => void;
  label?: string;
  allowClear?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const src = resolveImageUrl(image, mode);

  async function handleFile(file: File) {
    setBusy(true);
    setError('');
    const controller = new AbortController();
    try {
      const processed = await processPhoto(file, controller.signal);
      const uploaded = await uploadContentAsset(file, controller.signal);
      onChange({
        assetKey: uploaded.assetKey,
        alt: image?.alt || file.name.replace(/\.[^.]+$/, ''),
        width: processed.width,
        height: processed.height,
        hash: processed.hash,
        placeholder: processed.placeholder,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload image.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="asset-uploader">
      <div className="asset-uploader-preview">
        {src ? (
          <a href={src} target="_blank" rel="noopener noreferrer" title="Open full image">
            <img src={src} alt={image?.alt || 'Preview'} />
          </a>
        ) : (
          <div className="asset-placeholder">
            <Icon name="image" size={24} />
            <span>No image</span>
          </div>
        )}
      </div>
      <div className="asset-uploader-controls">
        <label className="button button-secondary button-sm file-picker">
          <Icon name="upload" size={14} />
          <span>{busy ? 'Uploading…' : src ? 'Replace photo' : label}</span>
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
          <a className="text-button" href={src} target="_blank" rel="noopener noreferrer">
            <Icon name="arrow" size={13} /> View full image
          </a>
        )}
        {allowClear && src && (
          <button type="button" className="text-button" onClick={() => onChange(undefined)} disabled={busy}>
            Use silhouette placeholder
          </button>
        )}
        {error && <span className="inline-error">{error}</span>}
      </div>
    </div>
  );
}

export function BlockEditorBody({
  block,
  mode,
  onChange,
  driveCaches,
  onDriveCacheUpdated,
  driveConfigured,
}: {
  block: PageBlock;
  mode: AdminMode;
  onChange: (next: PageBlock) => void;
  driveCaches: Record<string, DriveFolderCache>;
  onDriveCacheUpdated: (cache: DriveFolderCache) => void;
  driveConfigured: boolean;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [localError, setLocalError] = useState('');

  async function uploadDocumentFile(file: File, onUploaded: (doc: DocumentRef) => void) {
    setBusyKey(file.name);
    setLocalError('');
    try {
      const uploaded = await uploadContentAsset(file);
      onUploaded({
        id: newBlockId(),
        label: uploaded.filename,
        filename: uploaded.filename,
        assetKey: uploaded.assetKey,
        sizeBytes: uploaded.sizeBytes,
        fileType: inferDocType(uploaded.filename, uploaded.contentType),
      });
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : 'Document upload failed.');
    } finally {
      setBusyKey(null);
    }
  }

  switch (block.type) {
    case 'heading':
      return (
        <div className="block-fields">
          <div className="field-row">
            <label>
              <span>Heading text</span>
              <input value={block.text} onChange={e => onChange({ ...block, text: e.target.value })} />
            </label>
            <label>
              <span>Alignment</span>
              <select value={block.align} onChange={e => onChange({ ...block, align: e.target.value === 'center' ? 'center' : 'left' })}>
                <option value="left">Left</option>
                <option value="center">Center</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              <span>Subtitle (optional)</span>
              <input value={block.subtitle || ''} onChange={e => onChange({ ...block, subtitle: e.target.value || undefined })} />
            </label>
            <label>
              <span>Section anchor ID (optional)</span>
              <input value={block.anchor || ''} onChange={e => onChange({ ...block, anchor: e.target.value || undefined })} placeholder="e.g. students" />
            </label>
          </div>
        </div>
      );

    case 'rich-text':
      return (
        <div className="block-fields">
          <RichTextEditor value={block.content} onChange={content => onChange({ ...block, content })} minHeight={120} />
        </div>
      );

    case 'button-bar':
      return (
        <div className="block-fields">
          <div className="sublist-header">
            <strong>Buttons ({block.buttons.length})</strong>
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() =>
                onChange({
                  ...block,
                  buttons: [...block.buttons, { id: newBlockId(), label: 'Button', href: '#top', style: 'primary' }],
                })
              }
            >
              <Icon name="plus" size={14} /> Add button
            </button>
          </div>
          <div className="nested-list">
            {block.buttons.map((btn, idx) => (
              <div className="nested-item" key={btn.id}>
                <div className="field-row three-col">
                  <label>
                    <span>Label</span>
                    <input
                      value={btn.label}
                      onChange={e =>
                        onChange({
                          ...block,
                          buttons: block.buttons.map(b => (b.id === btn.id ? { ...b, label: e.target.value } : b)),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Target (#anchor, /page, or https://)</span>
                    <input
                      value={btn.href}
                      onChange={e =>
                        onChange({
                          ...block,
                          buttons: block.buttons.map(b => (b.id === btn.id ? { ...b, href: e.target.value } : b)),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Style</span>
                    <select
                      value={btn.style || 'primary'}
                      onChange={e =>
                        onChange({
                          ...block,
                          buttons: block.buttons.map(b =>
                            b.id === btn.id ? { ...b, style: e.target.value === 'secondary' ? 'secondary' : 'primary' } : b
                          ),
                        })
                      }
                    >
                      <option value="primary">Maroon filled</option>
                      <option value="secondary">Outlined</option>
                    </select>
                  </label>
                </div>
                <div className="nested-actions">
                  <button type="button" className="icon-button" aria-label="Move up" disabled={idx === 0} onClick={() => onChange({ ...block, buttons: moveItem(block.buttons, idx, idx - 1) })}><Icon name="up" size={15} /></button>
                  <button type="button" className="icon-button" aria-label="Move down" disabled={idx === block.buttons.length - 1} onClick={() => onChange({ ...block, buttons: moveItem(block.buttons, idx, idx + 1) })}><Icon name="down" size={15} /></button>
                  <button type="button" className="icon-button danger" aria-label="Delete button" disabled={block.buttons.length <= 1} onClick={() => onChange({ ...block, buttons: block.buttons.filter(b => b.id !== btn.id) })}><Icon name="trash" size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      );

    case 'image':
      return (
        <div className="block-fields">
          <ImageUploader
            image={block.image}
            mode={mode}
            onChange={img => img && onChange({ ...block, image: img })}
          />
          <div className="field-row">
            <label>
              <span>Alt description</span>
              <input value={block.image.alt} onChange={e => onChange({ ...block, image: { ...block.image, alt: e.target.value } })} />
            </label>
            <label>
              <span>Caption (optional)</span>
              <input value={block.caption || ''} onChange={e => onChange({ ...block, caption: e.target.value || undefined })} />
            </label>
            <label>
              <span>Max width (px)</span>
              <input
                type="number"
                min={80}
                max={1600}
                value={block.maxWidth || 450}
                onChange={e => onChange({ ...block, maxWidth: Number(e.target.value) || 450 })}
              />
            </label>
          </div>
        </div>
      );

    case 'divider':
      return (
        <div className="block-fields field-row">
          <label>
            <span>Spacing</span>
            <select value={block.spacing} onChange={e => onChange({ ...block, spacing: e.target.value as 'sm' | 'md' | 'lg' })}>
              <option value="sm">Small (16px)</option>
              <option value="md">Medium (32px)</option>
              <option value="lg">Large (56px)</option>
            </select>
          </label>
          <label className="checkbox-label inline-check">
            <input type="checkbox" checked={Boolean(block.showLine)} onChange={e => onChange({ ...block, showLine: e.target.checked })} />
            <span>Show horizontal rule line</span>
          </label>
        </div>
      );

    case 'faq-group':
      return (
        <div className="block-fields">
          <div className="field-row three-col">
            <label>
              <span>Section heading</span>
              <input value={block.heading} onChange={e => onChange({ ...block, heading: e.target.value })} />
            </label>
            <label>
              <span>Anchor ID</span>
              <input value={block.anchor} onChange={e => onChange({ ...block, anchor: e.target.value })} />
            </label>
            <label>
              <span>Jump button label</span>
              <input value={block.buttonLabel} onChange={e => onChange({ ...block, buttonLabel: e.target.value })} />
            </label>
          </div>
          <div className="sublist-header">
            <strong>Questions ({block.items.length})</strong>
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() =>
                onChange({
                  ...block,
                  items: [
                    ...block.items,
                    {
                      id: newBlockId(),
                      question: `${block.items.length + 1}. New question?`,
                      answer: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
                    },
                  ],
                })
              }
            >
              <Icon name="plus" size={14} /> Add question
            </button>
          </div>
          <div className="nested-list">
            {block.items.map((item, idx) => (
              <div className="nested-card" key={item.id}>
                <div className="nested-card-head">
                  <span className="nested-index">Q{idx + 1}</span>
                  <input
                    className="nested-title-input"
                    value={item.question}
                    placeholder="Question"
                    onChange={e =>
                      onChange({
                        ...block,
                        items: block.items.map(q => (q.id === item.id ? { ...q, question: e.target.value } : q)),
                      })
                    }
                  />
                  <div className="nested-actions">
                    <button type="button" className="icon-button" aria-label="Move question up" disabled={idx === 0} onClick={() => onChange({ ...block, items: moveItem(block.items, idx, idx - 1) })}><Icon name="up" size={15} /></button>
                    <button type="button" className="icon-button" aria-label="Move question down" disabled={idx === block.items.length - 1} onClick={() => onChange({ ...block, items: moveItem(block.items, idx, idx + 1) })}><Icon name="down" size={15} /></button>
                    <button type="button" className="icon-button danger" aria-label="Remove question" onClick={() => onChange({ ...block, items: block.items.filter(q => q.id !== item.id) })}><Icon name="trash" size={15} /></button>
                  </div>
                </div>
                <RichTextEditor
                  value={item.answer}
                  onChange={answer =>
                    onChange({
                      ...block,
                      items: block.items.map(q => (q.id === item.id ? { ...q, answer } : q)),
                    })
                  }
                  placeholder="Write answer…"
                />
              </div>
            ))}
          </div>
        </div>
      );

    case 'team-group':
      return (
        <div className="block-fields">
          <div className="field-row">
            <label>
              <span>Group heading</span>
              <input value={block.heading} onChange={e => onChange({ ...block, heading: e.target.value })} />
            </label>
            <label>
              <span>Grid layout</span>
              <select value={block.layout} onChange={e => onChange({ ...block, layout: e.target.value === 'leaders' ? 'leaders' : 'executives' })}>
                <option value="executives">Executive Cards (auto-fit)</option>
                <option value="leaders">Section Leaders (2×2 grid)</option>
              </select>
            </label>
          </div>
          <div className="sublist-header">
            <strong>Members ({block.members.length})</strong>
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() =>
                onChange({
                  ...block,
                  members: [
                    ...block.members,
                    {
                      id: newBlockId(),
                      name: 'New Member',
                      role: 'Role',
                      bio: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
                    },
                  ],
                })
              }
            >
              <Icon name="plus" size={14} /> Add member
            </button>
          </div>
          <div className="nested-list">
            {block.members.map((member, idx) => {
              const updateMember = (patch: Partial<TeamMember>) =>
                onChange({
                  ...block,
                  members: block.members.map(m => (m.id === member.id ? { ...m, ...patch } : m)),
                });
              return (
                <div className="nested-card" key={member.id}>
                  <div className="nested-card-head">
                    <span className="nested-index">#{idx + 1}</span>
                    <strong className="nested-card-title">{member.name}</strong>
                    <div className="nested-actions">
                      <button type="button" className="icon-button" aria-label="Move member up" disabled={idx === 0} onClick={() => onChange({ ...block, members: moveItem(block.members, idx, idx - 1) })}><Icon name="up" size={15} /></button>
                      <button type="button" className="icon-button" aria-label="Move member down" disabled={idx === block.members.length - 1} onClick={() => onChange({ ...block, members: moveItem(block.members, idx, idx + 1) })}><Icon name="down" size={15} /></button>
                      <button type="button" className="icon-button danger" aria-label="Remove member" onClick={() => onChange({ ...block, members: block.members.filter(m => m.id !== member.id) })}><Icon name="trash" size={15} /></button>
                    </div>
                  </div>
                  <div className="team-member-editor-grid">
                    <ImageUploader image={member.photo} mode={mode} onChange={photo => updateMember({ photo })} label="Upload portrait" allowClear />
                    <div className="field-stack">
                      <div className="field-row">
                        <label>
                          <span>Name</span>
                          <input value={member.name} onChange={e => updateMember({ name: e.target.value })} />
                        </label>
                        <label>
                          <span>Pronouns (optional)</span>
                          <input value={member.pronouns || ''} placeholder="(she/her)" onChange={e => updateMember({ pronouns: e.target.value || undefined })} />
                        </label>
                      </div>
                      <div className="field-row">
                        <label>
                          <span>Role / Instrument</span>
                          <input value={member.role} onChange={e => updateMember({ role: e.target.value })} />
                        </label>
                        <label>
                          <span>Program / Year (optional)</span>
                          <input value={member.program || ''} onChange={e => updateMember({ program: e.target.value || undefined })} />
                        </label>
                      </div>
                      <div>
                        <span className="field-sub-label">Bio</span>
                        <RichTextEditor value={member.bio} onChange={bio => updateMember({ bio })} minHeight={80} placeholder="Write member bio…" />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );

    case 'document-list':
      return (
        <div className="block-fields">
          <div className="field-row">
            <label>
              <span>Section heading (e.g. 2025-2026 or Bylaws)</span>
              <input value={block.heading} onChange={e => onChange({ ...block, heading: e.target.value })} />
            </label>
            <label>
              <span>Subtitle (optional)</span>
              <input value={block.subtitle || ''} onChange={e => onChange({ ...block, subtitle: e.target.value || undefined })} />
            </label>
          </div>
          <div className="sublist-header">
            <strong>Documents ({block.documents.length})</strong>
            <div className="sublist-buttons">
              <label className="button button-primary button-sm file-picker">
                <Icon name="upload" size={14} />
                <span>{busyKey ? 'Uploading…' : 'Upload PDF / XLSX / DOCX'}</span>
                <input
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv,.docx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={Boolean(busyKey)}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) {
                      void uploadDocumentFile(file, newDoc =>
                        onChange({ ...block, documents: [...block.documents, newDoc] })
                      );
                    }
                  }}
                />
              </label>
            </div>
          </div>
          {localError && <div className="form-error">{localError}</div>}
          <div className="nested-list">
            {block.documents.map((doc, idx) => {
              const docHref = resolveDocumentUrl(doc, mode);
              return (
                <div className="nested-item" key={doc.id}>
                  <div className="field-row">
                    <label>
                      <span>Display title</span>
                      <input
                        value={doc.label}
                        onChange={e =>
                          onChange({
                            ...block,
                            documents: block.documents.map(d => (d.id === doc.id ? { ...d, label: e.target.value } : d)),
                          })
                        }
                      />
                    </label>
                    <div className="doc-file-cell">
                      <span className="field-sub-label">File ({doc.fileType.toUpperCase()})</span>
                      <div className="doc-file-links">
                        {docHref ? (
                          <a className="doc-file-link" href={docHref} target="_blank" rel="noopener noreferrer">
                            {doc.filename}
                          </a>
                        ) : (
                          <span className="doc-file-name">{doc.filename}</span>
                        )}
                        <div className="doc-file-buttons">
                          {docHref && (
                            <a className="button button-secondary button-sm" href={docHref} target="_blank" rel="noopener noreferrer">
                              <Icon name="arrow" size={13} /> {doc.fileType === 'link' ? 'Open' : 'View / Download'}
                            </a>
                          )}
                          <label className="button button-secondary button-sm file-picker">
                            <Icon name="upload" size={13} />
                            <span>Replace</span>
                            <input
                              type="file"
                              accept=".pdf,.xlsx,.xls,.csv,.docx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                              disabled={Boolean(busyKey)}
                              onChange={e => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (file) {
                                  void uploadDocumentFile(file, uploaded =>
                                    onChange({
                                      ...block,
                                      documents: block.documents.map(d =>
                                        d.id === doc.id
                                          ? {
                                              ...uploaded,
                                              id: doc.id,
                                              label: doc.label && doc.label !== doc.filename ? doc.label : uploaded.filename,
                                            }
                                          : d
                                      ),
                                    })
                                  );
                                }
                              }}
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="nested-actions">
                    <button type="button" className="icon-button" aria-label="Move document up" disabled={idx === 0} onClick={() => onChange({ ...block, documents: moveItem(block.documents, idx, idx - 1) })}><Icon name="up" size={15} /></button>
                    <button type="button" className="icon-button" aria-label="Move document down" disabled={idx === block.documents.length - 1} onClick={() => onChange({ ...block, documents: moveItem(block.documents, idx, idx + 1) })}><Icon name="down" size={15} /></button>
                    <button type="button" className="icon-button danger" aria-label="Remove document" onClick={() => onChange({ ...block, documents: block.documents.filter(d => d.id !== doc.id) })}><Icon name="trash" size={15} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );

    case 'drive-minutes': {
      const cache = block.folderId ? driveCaches[block.folderId] : undefined;
      const syncNow = async () => {
        setBusyKey('drive');
        setLocalError('');
        try {
          const res = await api<{ cache: DriveFolderCache }>('/api/admin/drive/sync', {
            method: 'POST',
            body: JSON.stringify({ folderUrl: block.folderUrl || block.folderId }),
          });
          onDriveCacheUpdated(res.cache);
        } catch (caught) {
          setLocalError(caught instanceof Error ? caught.message : 'Google Drive sync failed.');
        } finally {
          setBusyKey(null);
        }
      };

      return (
        <div className="block-fields">
          <div className="field-row">
            <label>
              <span>Section heading</span>
              <input value={block.heading} onChange={e => onChange({ ...block, heading: e.target.value })} />
            </label>
            <label>
              <span>Folder button label</span>
              <input value={block.fallbackLabel || ''} onChange={e => onChange({ ...block, fallbackLabel: e.target.value || undefined })} placeholder="Open Folder in Google Drive" />
            </label>
          </div>
          <div className="drive-url-row">
            <label>
              <span>Google Drive Folder URL (must be shared: &ldquo;Anyone with the link can view&rdquo;)</span>
              <input
                value={block.folderUrl}
                placeholder="https://drive.google.com/drive/folders/..."
                onChange={e => {
                  const url = e.target.value;
                  const id = extractDriveFolderId(url) || '';
                  onChange({ ...block, folderUrl: url, folderId: id });
                }}
              />
            </label>
            <button
              type="button"
              className="button button-secondary"
              disabled={!block.folderId || busyKey === 'drive'}
              onClick={() => void syncNow()}
            >
              <Icon name="refresh" size={15} />
              <span>{busyKey === 'drive' ? 'Syncing…' : 'Sync Now'}</span>
            </button>
            {block.folderId && (
              <a
                className="button button-secondary"
                href={block.folderUrl || `https://drive.google.com/drive/folders/${block.folderId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="arrow" size={14} /> Open folder
              </a>
            )}
          </div>
          {!driveConfigured && (
            <div className="development-note">
              Google Drive API key (<code>GOOGLE_DRIVE_API_KEY</code>) is not set in this environment. The folder link button still works, and auto-listing activates once the key is configured.
            </div>
          )}
          {localError && <div className="form-error">{localError}</div>}
          <div className="field-row three-col">
            <label>
              <span>Sort order</span>
              <select value={block.sortOrder} onChange={e => onChange({ ...block, sortOrder: e.target.value as 'name-desc' | 'name-asc' | 'modified-desc' })}>
                <option value="name-desc">Name (newest / Z–A)</option>
                <option value="name-asc">Name (A–Z)</option>
                <option value="modified-desc">Last modified (newest)</option>
              </select>
            </label>
            <label className="checkbox-label inline-check">
              <input type="checkbox" checked={block.groupBySubfolder} onChange={e => onChange({ ...block, groupBySubfolder: e.target.checked })} />
              <span>Group by year subfolders</span>
            </label>
            <label className="checkbox-label inline-check">
              <input type="checkbox" checked={block.showDates} onChange={e => onChange({ ...block, showDates: e.target.checked })} />
              <span>Show modified dates</span>
            </label>
          </div>
          {cache && (
            <div className="drive-cache-summary">
              <strong>
                Synced {new Date(cache.syncedAt).toLocaleString()} — {cache.subfolders.length} subfolders,{' '}
                {cache.rootFiles.length + cache.subfolders.reduce((sum, s) => sum + s.files.length, 0)} files
              </strong>
              <ul>
                {cache.subfolders.map(sub => (
                  <li key={sub.id}>
                    <strong>{sub.name}</strong> ({sub.files.length} files)
                    {sub.files.length > 0 && (
                      <ul className="drive-subfile-list">
                        {sub.files.slice(0, 6).map(file => (
                          <li key={file.id}>
                            <a href={file.webViewLink} target="_blank" rel="noopener noreferrer">{file.name}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
                {cache.rootFiles.slice(0, 6).map(file => (
                  <li key={file.id}>
                    <a href={file.webViewLink} target="_blank" rel="noopener noreferrer">{file.name}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    }

    case 'sponsor-grid':
      return (
        <div className="block-fields">
          <label>
            <span>Section heading</span>
            <input value={block.heading} onChange={e => onChange({ ...block, heading: e.target.value })} />
          </label>
          <div className="sublist-header">
            <strong>Sponsors ({block.sponsors.length})</strong>
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() =>
                onChange({
                  ...block,
                  sponsors: [
                    ...block.sponsors,
                    { id: newBlockId(), name: 'New Sponsor', logo: { alt: 'Sponsor logo' } },
                  ],
                })
              }
            >
              <Icon name="plus" size={14} /> Add sponsor
            </button>
          </div>
          <div className="nested-list">
            {block.sponsors.map((sponsor, idx) => (
              <div className="nested-card" key={sponsor.id}>
                <div className="nested-card-head">
                  <span className="nested-index">#{idx + 1}</span>
                  <strong className="nested-card-title">{sponsor.name}</strong>
                  <div className="nested-actions">
                    <button type="button" className="icon-button" aria-label="Move sponsor up" disabled={idx === 0} onClick={() => onChange({ ...block, sponsors: moveItem(block.sponsors, idx, idx - 1) })}><Icon name="up" size={15} /></button>
                    <button type="button" className="icon-button" aria-label="Move sponsor down" disabled={idx === block.sponsors.length - 1} onClick={() => onChange({ ...block, sponsors: moveItem(block.sponsors, idx, idx + 1) })}><Icon name="down" size={15} /></button>
                    <button type="button" className="icon-button danger" aria-label="Remove sponsor" onClick={() => onChange({ ...block, sponsors: block.sponsors.filter(s => s.id !== sponsor.id) })}><Icon name="trash" size={15} /></button>
                  </div>
                </div>
                <div className="team-member-editor-grid">
                  <ImageUploader
                    image={sponsor.logo}
                    mode={mode}
                    onChange={logo =>
                      logo &&
                      onChange({
                        ...block,
                        sponsors: block.sponsors.map(s => (s.id === sponsor.id ? { ...s, logo } : s)),
                      })
                    }
                    label="Upload logo"
                  />
                  <div className="field-stack">
                    <label>
                      <span>Sponsor name</span>
                      <input
                        value={sponsor.name}
                        onChange={e =>
                          onChange({
                            ...block,
                            sponsors: block.sponsors.map(s => (s.id === sponsor.id ? { ...s, name: e.target.value } : s)),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Website URL (optional)</span>
                      <input
                        value={sponsor.href || ''}
                        placeholder="https://..."
                        onChange={e =>
                          onChange({
                            ...block,
                            sponsors: block.sponsors.map(s =>
                              s.id === sponsor.id ? { ...s, href: e.target.value || undefined } : s
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
  }
}
