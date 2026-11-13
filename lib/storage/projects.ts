/* ============================================================
 * OpenMindmap — lib/storage/projects.ts
 * LOCK-09: Auto Save thật, atomic/revision-aware, backup/recovery,
 * conflict detection; `Đã lưu` chỉ khi ghi được xác thực.
 * DraftJournal tách khỏi Document (17.3).
 * Lưu trữ: localStorage (bản web của "app-data"); multi-tab qua
 * storage event = external conflict.
 * ============================================================ */
import { assertUniqueTopicIds, ProjectDocV3, uuid } from '../core/types'

const K = {
  registry: 'omm.registry.v3',
  settings: 'omm.settings.v3',
  project: (id: string) => `omm.project.${id}`,
  backup: (id: string) => `omm.backup.${id}`,
  journal: (id: string) => `omm.journal.${id}`,
  trash: 'omm.trash.v3',
  cleanShutdown: 'omm.cleanShutdown',
  session: (id: string) => `omm.session.${id}`,
}

export interface ProjectMeta {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  revision: number
  lastOpened: string
  nodeCount: number
}

export interface DraftJournalRecord {
  journal_schema_version: 1
  project_id: string
  node_id: string
  field: 'title' | 'notes'
  base_document_revision: number
  base_field_value?: string
  draft_text: string
  timestamp: string
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/* ---------- Registry ---------- */
export function loadRegistry(): ProjectMeta[] {
  return safeParse<ProjectMeta[]>(localStorage.getItem(K.registry), [])
}
export function saveRegistry(list: ProjectMeta[]) {
  localStorage.setItem(K.registry, JSON.stringify(list))
}
export function upsertMeta(meta: ProjectMeta) {
  const list = loadRegistry().filter((m) => m.id !== meta.id)
  list.unshift(meta)
  saveRegistry(list)
}
export function removeMeta(id: string) {
  saveRegistry(loadRegistry().filter((m) => m.id !== id))
}
export function metaFromDoc(doc: ProjectDocV3, prev?: ProjectMeta): ProjectMeta {
  return {
    id: doc.project_id,
    name: doc.name,
    createdAt: prev?.createdAt ?? doc.created_at,
    updatedAt: doc.updated_at,
    revision: doc.document_revision,
    lastOpened: new Date().toISOString(),
    nodeCount: doc.topics.length,
  }
}

/* ---------- Trash (Delete to Trash — PR05) ---------- */
export interface TrashItem { id: string; name: string; deletedAt: string; doc: ProjectDocV3 }
export function trashList(): TrashItem[] { return safeParse<TrashItem[]>(localStorage.getItem(K.trash), []) }
export function pushTrash(doc: ProjectDocV3) {
  const list = trashList().filter(item => item.id !== doc.project_id)
  list.unshift({ id: doc.project_id, name: doc.name, deletedAt: new Date().toISOString(), doc })
  localStorage.setItem(K.trash, JSON.stringify(list.slice(0, 50)))
}
export function removeFromTrash(id: string) {
  saveTrashList(trashList().filter((t) => t.id !== id))
}
function saveTrashList(list: TrashItem[]) {
  localStorage.setItem(K.trash, JSON.stringify(list))
}

/* ---------- Atomic save + verify (LOCK-09) ---------- */
export function saveProjectAtomic(doc: ProjectDocV3): { ok: true; hash: string } | { ok: false; error: string } {
  try {
    const json = JSON.stringify(doc)
    const hash = simpleHash(json)
    const key = K.project(doc.project_id)
    localStorage.setItem(key, json)
    // xác thực ghi: đọc lại + so hash
    const readBack = localStorage.getItem(key)
    if (!readBack || simpleHash(readBack) !== hash) return { ok: false, error: 'Xác thực ghi thất bại' }
    return { ok: true, hash }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Quota vượt hạn mức' }
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Stored projects already use the app model. Import validation is a separate boundary. */
export function readStoredProject(raw: string | null, id: string): ProjectDocV3 | null {
  const doc = safeParse<ProjectDocV3 | null>(raw, null)
  if (!doc || doc.project_id !== id || typeof doc.name !== 'string'
    || typeof doc.created_at !== 'string' || typeof doc.updated_at !== 'string'
    || !Number.isFinite(doc.document_revision) || typeof doc.central_topic_id !== 'string'
    || !isRecord(doc.layout) || !isRecord(doc.map_style_overrides)
    || !Array.isArray(doc.topics) || !doc.topics.every(t => isRecord(t) && typeof t.id === 'string'
      && typeof t.text === 'string' && (t.notes == null || typeof t.notes === 'string') && isRecord(t.style))
    || !doc.topics.some(t => t.id === doc.central_topic_id)
    || !Array.isArray(doc.crosslinks) || !doc.crosslinks.every(isRecord)
    || !Array.isArray(doc.drawings) || !doc.drawings.every(d => isRecord(d) && Array.isArray(d.points) && d.points.every(isRecord))
    || !Array.isArray(doc.assets) || !doc.assets.every(isRecord)) return null
  try { assertUniqueTopicIds(doc.topics) } catch { return null }
  return doc
}
export function loadProject(id: string): ProjectDocV3 | null {
  return readStoredProject(localStorage.getItem(K.project(id)), id)
}
export function projectExists(id: string): boolean {
  return localStorage.getItem(K.project(id)) !== null
}

/* ---------- Backup ring (mỗi lần lưu; số lượng theo settings.backupCount) ---------- */
export function pushBackup(doc: ProjectDocV3, keep = 5) {
  if (keep <= 0) return // người dùng tắt backup qua Cài đặt
  try {
    const list = safeParse<{ rev: number; json: string }[]>(localStorage.getItem(K.backup(doc.project_id)), [])
    list.unshift({ rev: doc.document_revision, json: JSON.stringify(doc) })
    localStorage.setItem(K.backup(doc.project_id), JSON.stringify(list.slice(0, keep)))
  } catch { /* quota — bỏ qua backup, không chặn lưu chính */ }
}
function latestBackup(id: string, onUnreadable: (id: string) => void, nodeId?: string): { rev: number; doc: ProjectDocV3 } | null {
  const raw = localStorage.getItem(K.backup(id))
  if (raw === null) return null
  const list = safeParse<unknown>(raw, null)
  if (!Array.isArray(list)) { onUnreadable(id); return null }
  for (const item of list) {
    if (isRecord(item) && typeof item.json === 'string' && typeof item.rev === 'number' && Number.isFinite(item.rev)) {
      const doc = readStoredProject(item.json, id)
      if (doc) {
        if (!nodeId || doc.topics.some(t => t.id === nodeId)) return { rev: item.rev, doc }
        continue
      }
    }
    onUnreadable(id)
  }
  return null
}

/* ---------- DraftJournal (17.3) ---------- */
export function writeDraftJournal(rec: DraftJournalRecord) {
  try { localStorage.setItem(K.journal(rec.project_id), JSON.stringify(rec)) } catch { /* không giả an toàn */ }
}
export function readDraftJournal(projectId: string): DraftJournalRecord | null {
  return safeParse<DraftJournalRecord | null>(localStorage.getItem(K.journal(projectId)), null)
}
export function clearDraftJournal(projectId: string) {
  localStorage.removeItem(K.journal(projectId))
}
function allDraftJournals(onUnreadable: (id: string) => void): DraftJournalRecord[] {
  const out: DraftJournalRecord[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('omm.journal.')) {
      const rec = safeParse<DraftJournalRecord | null>(localStorage.getItem(key), null)
      const id = key.slice('omm.journal.'.length)
      if (isRecord(rec) && rec.project_id === id && typeof rec.node_id === 'string'
        && (rec.field === 'title' || rec.field === 'notes') && Number.isFinite(rec.base_document_revision)
        && (rec.base_field_value === undefined || typeof rec.base_field_value === 'string')
        && typeof rec.draft_text === 'string' && typeof rec.timestamp === 'string') out.push(rec)
      else onUnreadable(id)
    }
  }
  return out
}

/* ---------- Recovery snapshot khi crash ---------- */
export function markCleanShutdown() { localStorage.setItem(K.cleanShutdown, '1') }
export function wasCleanShutdown(): boolean { return localStorage.getItem(K.cleanShutdown) === '1' }
export function clearCleanShutdownFlag() { localStorage.removeItem(K.cleanShutdown) }

export interface RecoveryCandidate {
  kind: 'draft' | 'backup'
  projectId: string
  projectName: string
  timestamp: string
  detail: string
  doc: ProjectDocV3
  draft?: DraftJournalRecord
  baseRaw?: string
}
export function collectRecoveryCandidates(onUnreadable: (id: string) => void = () => {}): RecoveryCandidate[] {
  const out: RecoveryCandidate[] = []
  const registry = loadRegistry()
  for (const j of allDraftJournals(onUnreadable)) {
    const id = j.project_id
    const raw = localStorage.getItem(K.project(id))
    const doc = readStoredProject(raw, id)
    const node = doc?.topics.find(t => t.id === j.node_id)
    if (doc && node) {
      if ((j.field === 'title' ? node.text : node.notes ?? '') === j.draft_text) continue
      out.push({
        kind: 'draft', projectId: id, projectName: doc.name, timestamp: j.timestamp,
        detail: `Bản nháp ${j.field === 'title' ? 'tiêu đề' : 'ghi chú'} tại node "${nodeText(doc, j.node_id)}" (rev ${j.base_document_revision})`,
        doc, draft: j, baseRaw: raw ?? undefined,
      })
    } else {
      onUnreadable(id)
      const b = latestBackup(id, onUnreadable, j.node_id)
      if (b) out.push({ kind: 'draft', projectId: id, projectName: b.doc.name, timestamp: j.timestamp, detail: 'Bản nháp từ bản sao lưu', doc: b.doc, draft: j })
    }
  }
  if (!wasCleanShutdown()) {
    for (const m of registry) {
      const b = latestBackup(m.id, onUnreadable)
      const raw = localStorage.getItem(K.project(m.id))
      const cur = readStoredProject(raw, m.id)
      if (raw !== null && !cur) onUnreadable(m.id)
      if (b && cur && b.rev > cur.document_revision) {
        out.push({ kind: 'backup', projectId: m.id, projectName: m.name, timestamp: cur.updated_at, detail: `Backup rev ${b.rev} mới hơn bản lưu rev ${cur.document_revision}`, doc: b.doc })
      }
    }
  }
  return out
}
function nodeText(doc: ProjectDocV3, id: string): string {
  return doc.topics.find((t) => t.id === id)?.text?.slice(0, 40) ?? '(node đã xóa)'
}

/* ---------- Conflict multi-tab qua storage event ---------- */
export function watchProjectConflict(projectId: string, onExternalWrite: (raw: string | null) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === K.project(projectId) || e.key === null) onExternalWrite(e.newValue)
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

/* ---------- Session viewport per project (AppSettings.session_by_project) ---------- */
export interface SessionView { camera: { x: number; y: number; zoom: number }; sidebar?: string }
export function saveSession(projectId: string, view: SessionView) {
  try { localStorage.setItem(K.session(projectId), JSON.stringify(view)) } catch { /* ignore */ }
}
export function loadSession(projectId: string): SessionView | null {
  return safeParse<SessionView | null>(localStorage.getItem(K.session(projectId)), null)
}

/* ---------- AppSettings ---------- */
export interface AppSettings {
  settings_schema_version: 3
  language: 'vi'
  appearance: 'system' | 'light' | 'dark'
  reduceMotion: boolean
  helpTooltips: boolean
  defaultLayout: string
  defaultTheme: string
  autosaveEnabled: boolean
  autosaveIntervalMs: number
  backupCount: number
  draftJournalEnabled: boolean
  gridVisible: boolean
  gridSpacing: number
  snapToGrid: boolean
  minimapDefault: boolean
  /* SET-C16: bán kính Tẩy đối tượng (Object Eraser only) — 4–64 world, mặc định 12 */
  eraserRadius: number
  lastProjectId: string | null
  sessionByProject: Record<string, { camera?: { x: number; y: number; zoom: number } }>
}
export function defaultSettings(): AppSettings {
  return {
    settings_schema_version: 3,
    language: 'vi',
    appearance: 'system',
    reduceMotion: false,
    helpTooltips: true,
    defaultLayout: 'balanced',
    defaultTheme: 'modern-blue',
    autosaveEnabled: true,
    autosaveIntervalMs: 800,
    backupCount: 5,
    draftJournalEnabled: true,
    gridVisible: false,
    gridSpacing: 24,
    snapToGrid: false,
    minimapDefault: false,
    eraserRadius: 12,
    lastProjectId: null,
    sessionByProject: {},
  }
}
export function loadSettings(): AppSettings {
  return { ...defaultSettings(), ...safeParse<Partial<AppSettings>>(localStorage.getItem(K.settings), {}) }
}
export function saveSettings(s: AppSettings) {
  localStorage.setItem(K.settings, JSON.stringify(s))
}

export function simpleHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619)
    h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519)
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0')
}

export { K as STORAGE_KEYS }
