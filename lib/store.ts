/* ============================================================
 * OpenMindmap — lib/store.ts
 * AppState: Document (qua Command duy nhất — LOCK-06), History,
 * AppSettings, ViewState (không tăng DocRevision), dialogs, toasts.
 * ============================================================ */
'use client'

import { create } from 'zustand'
import { fitChangedFixedNodes, buildScene } from './scene/scene'
import {
  ProjectDocV3, Topic, newProjectDoc, getTheme, uuid, newTopic, LayoutKind, defaultLayout, assertUniqueTopicIds, assertValidImportedProject,
} from './core/types'
import { Command, applyCommand, cmdBuilders, makeChildTopic } from './core/commands'
import { getTopic, descendantsOf, childrenOf, subtreeSize } from './core/tree'
import {
  AppSettings, loadSettings, saveSettings, defaultSettings,
  loadRegistry, upsertMeta, removeMeta, metaFromDoc, loadProject, readStoredProject,
  pushTrash, saveSession, loadSession, writeDraftJournal, clearDraftJournal,
  watchProjectConflict, markCleanShutdown, clearCleanShutdownFlag, collectRecoveryCandidates,
  RecoveryCandidate, simpleHash, readDraftJournal, trashList, removeFromTrash, STORAGE_KEYS,
} from './storage/projects'
import { commitNativeOpen, inspectNativeImportId, persistProject, projectRaw, withStorageWrite } from './storage/persistence'

export type SaveStatus = 'none' | 'clean' | 'dirty' | 'saving' | 'error' | 'conflict'
export type SaveResult = { kind: 'saved'; projectId: string; revision: number; stillDirty: boolean } | { kind: 'error' | 'conflict' | 'cancelled'; message?: string }
export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'rect' | 'ellipse'

/* Debounce ghi session camera: pan/zoom phát ~120 sự kiện/giây — ghi localStorage
 * từng frame làm khựng chuyển động. Chỉ ghi sau khi dừng 250ms (vẫn khôi phục
 * camera phiên bình thường, tối đa mất 250ms vị trí cuối khi đóng đột ngột). */
let _camSaveTimer: ReturnType<typeof setTimeout> | null = null
let _flushCamera: (() => void) | undefined

export interface Toast { id: string; severity: 'info' | 'warn' | 'error' | 'success'; text: string; detail?: string }
export interface EditorState { nodeId: string; field: 'title' | 'notes'; draft: string; baseText: string }
export interface ExportDialogState { open: boolean; optionsRevision: number | null; scopeRootId?: string | null }
export interface ImportDialogState { open: boolean }

const HISTORY_MAX_ENTRIES = 150
const HISTORY_MAX_BYTES = 48 * 1024 * 1024
const utf8Encoder = new TextEncoder()
const utf8ByteLength = (s: string) => utf8Encoder.encode(s).length

interface HistoryEntry { label: string; before: string; after: string; bytes: number }

export interface AppState {
  persistedRaw: string | null
  generation: number
  transitionBusy: boolean
  leavePrompt: { run: () => Promise<boolean>; resolve: (ok: boolean) => void } | null
  chooseLeave: (choice: 'save' | 'discard' | 'cancel') => Promise<void>
  restoreTrash: (id: string) => Promise<boolean>
  purgeTrash: (id: string) => Promise<boolean>
  renameStoredProject: (id: string, name: string) => Promise<boolean>
  hydrated: boolean
  settings: AppSettings
  registry: ReturnType<typeof loadRegistry>
  doc: ProjectDocV3 | null
  savedHash: string | null
  saveStatus: SaveStatus
  saveError: string | null
  past: HistoryEntry[]
  future: HistoryEntry[]
  /* view state (không dirty doc) */
  camera: { x: number; y: number; zoom: number }
  selection: string[]
  hoverId: string | null
  tool: Tool
  drawMode: boolean
  brush: { color: string; width: number }
  sidebar: 'open' | 'collapsed' | 'hidden'
  inspectorOpen: boolean
  inspectorTab: string | null
  minimapOn: boolean
  gridOn: boolean
  snapOn: boolean
  focusRootId: string | null
  cameraBeforeFocus: { x: number; y: number; zoom: number } | null
  search: { open: boolean; query: string; replace: string; matchCase: boolean; inNotes: boolean; index: number; matches: string[] }
  editor: EditorState | null
  /* dialogs */
  importOpen: boolean
  exportOpen: ExportDialogState | null
  settingsOpen: boolean
  shortcutsOpen: boolean
  recovery: { open: boolean; candidates: RecoveryCandidate[] }
  confirm: { message: string; detail?: string; danger?: boolean; onOk: () => void | boolean | Promise<boolean | void> } | null
  layoutPickerOpen: boolean
  themePickerOpen: boolean
  toasts: Toast[]
  /* internals */
  _autosaveTimer: ReturnType<typeof setTimeout> | null
  _journalTimer: ReturnType<typeof setTimeout> | null
  _unwatch: (() => void) | null

  init: () => void
  _startWatch: () => void
  /* project ops */
  createProject: (name?: string) => Promise<boolean>
  openProject: (id: string) => Promise<boolean>
  renameProject: (name: string) => void
  duplicateProject: (id: string) => Promise<boolean>
  deleteProject: (id: string) => void
  removeRecent: (id: string) => Promise<boolean>
  openNativeDoc: (doc: ProjectDocV3, options?: { taskId?: string; ignoreUpdatedAt?: boolean }) => Promise<boolean>
  importOutline: (doc: ProjectDocV3) => Promise<boolean>
  closeProject: () => Promise<boolean>
  /* commands */
  dispatch: (cmd: Command, label: string) => boolean
  undo: () => void
  redo: () => void
  /* save */
  saveNow: () => Promise<SaveResult>
  scheduleAutosave: () => void
  resolveConflictReload: () => Promise<boolean>
  resolveConflictSaveAs: () => Promise<boolean>
  /* view */
  setCamera: (c: { x: number; y: number; zoom: number }) => void
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string, additive: boolean) => void
  setTool: (t: Tool) => void
  setDrawMode: (v: boolean) => void
  setBrush: (b: Partial<AppState['brush']>) => void
  setSidebar: (s: 'open' | 'collapsed' | 'hidden') => void
  setInspector: (open: boolean, tab?: string | null) => void
  setMinimap: (v: boolean) => void
  setGrid: (v: boolean) => void
  setSnap: (v: boolean) => void
  focusBranch: (id: string) => void
  exitFocus: () => void
  openSearch: (v: boolean) => void
  setSearch: (s: Partial<AppState['search']>) => void
  setSettings: (patch: Partial<AppSettings>) => Promise<boolean>
  resetSettingsGroup: (group: 'general' | 'map' | 'canvas' | 'storage') => void
  /* editor + draft journal */
  startEdit: (nodeId: string, field: 'title' | 'notes') => void
  updateDraft: (text: string) => void
  commitEdit: () => boolean
  cancelEdit: () => void
  /* dialogs */
  setImportOpen: (v: boolean) => void
  openExport: (scopeRootId?: string | null) => void
  closeExport: () => void
  setSettingsOpen: (v: boolean) => void
  setShortcutsOpen: (v: boolean) => void
  dismissRecovery: (i: number) => void
  applyRecovery: (i: number, asCopy: boolean) => Promise<boolean>
  setConfirm: (c: AppState['confirm']) => void
  setLayoutPicker: (v: boolean) => void
  setThemePicker: (v: boolean) => void
  toast: (severity: Toast['severity'], text: string, detail?: string) => void
  dismissToast: (id: string) => void
  /* helpers */
  applyLayoutKind: (kind: LayoutKind) => void
  addNode: (parentId: string | null, text?: string, opts?: { index?: number | null; focus?: boolean }) => string | null
  addChildToSelection: () => void
  addSiblingToSelection: (before?: boolean) => void
  deleteSelection: () => void
  duplicateSelection: () => void
}

function pruneSelection(doc: ProjectDocV3, selection: string[]): string[] {
  const topicIds = new Set(doc.topics.map((t) => t.id))
  const drawingIds = new Set(doc.drawings.map((d) => d.id))
  const crosslinkIds = new Set(doc.crosslinks.map((c) => c.id))
  return selection.filter((id) => {
    if (id.startsWith('drawing:')) return drawingIds.has(id.slice('drawing:'.length))
    if (id.startsWith('crosslink:')) return crosslinkIds.has(id.slice('crosslink:'.length))
    return topicIds.has(id)
  })
}

export const useApp = create<AppState>((set, get) => ({
  persistedRaw: null, generation: 0, transitionBusy: false, leavePrompt: null,
  chooseLeave: async (choice) => {
    const prompt = get().leavePrompt
    if (!prompt) return
    set({ leavePrompt: null })
    if (choice === 'cancel') { prompt.resolve(false); if (get().saveStatus === 'dirty') get().scheduleAutosave(); return }
    prompt.resolve(await executeTransition(prompt.run, choice === 'save'))
  },
  hydrated: false,
  settings: defaultSettings(),
  registry: [],
  doc: null,
  savedHash: null,
  saveStatus: 'none',
  saveError: null,
  past: [],
  future: [],
  camera: { x: 0, y: 0, zoom: 1 },
  selection: [],
  hoverId: null,
  tool: 'select',
  drawMode: false,
  brush: { color: '#EF4444', width: 2.5 },
  sidebar: 'open',
  inspectorOpen: false,
  inspectorTab: null,
  minimapOn: false,
  gridOn: false,
  snapOn: false,
  focusRootId: null,
  cameraBeforeFocus: null,
  search: { open: false, query: '', replace: '', matchCase: false, inNotes: false, index: 0, matches: [] },
  editor: null,
  importOpen: false,
  exportOpen: null,
  settingsOpen: false,
  shortcutsOpen: false,
  recovery: { open: false, candidates: [] },
  confirm: null,
  layoutPickerOpen: false,
  themePickerOpen: false,
  toasts: [],
  _autosaveTimer: null,
  _journalTimer: null,
  _unwatch: null,

  /* ---------------- init ---------------- */
  init: () => {
    if (get().hydrated) return
    try {
    const settings = loadSettings()
    const registry = loadRegistry()
    const unreadable = new Set<string>()
    const candidates = collectRecoveryCandidates(id => unreadable.add(id))
    clearCleanShutdownFlag()
    set({ hydrated: true, settings, registry, recovery: { open: candidates.length > 0, candidates } })
    applyAppearance(settings.appearance)
    applyReduceMotion(settings.reduceMotion)
    // Áp dụng mặc định Canvas từ Cài đặt (trước đây 3 toggle này chỉ lưu,
    // không có code nào đọc để áp dụng)
    set({ gridOn: settings.gridVisible, snapOn: settings.snapToGrid, minimapOn: settings.minimapDefault })
    // mở project gần nhất
    const last = settings.lastProjectId && registry.find((m) => m.id === settings.lastProjectId)
    if (last) {
      if (loadProject(last.id)) void get().openProject(last.id)
      else unreadable.add(last.id)
    }
    if (unreadable.size) get().toast('warn', 'Một số dữ liệu không đọc được', [...unreadable].map(id => registry.find(m => m.id === id)?.name ?? id).join(', '))
    window.addEventListener('pagehide', flushCameraSession)
    window.addEventListener('beforeunload', (event) => {
      const cur = get()
      if (hasUnsaved(cur)) { event.preventDefault(); event.returnValue = ''; return }
      try { markCleanShutdown() } catch { /* never discard document on a storage error */ }
    })
    get()._startWatch()
    } catch (e) { set({ hydrated: true }); reportError('Không đọc được dữ liệu lưu trữ', e) }
  },

  _startWatch: () => {
    const st = get()
    const doc = st.doc
    st._unwatch?.()
    if (!doc) { set({ _unwatch: null }); return }
    const check = () => {
      try {
        const cur = get()
        if (cur.doc?.project_id === doc.project_id && projectRaw(doc.project_id) !== cur.persistedRaw) {
          if (cur.saveStatus !== 'conflict') cur.toast('warn', 'Xung đột tệp', 'Dự án đã thay đổi hoặc bị xóa ở tab khác. Chọn Tải lại hoặc Lưu thành.')
          set({ saveStatus: 'conflict' })
        }
      } catch (e) { reportError('Không đọc được dữ liệu', e) }
    }
    const stop = watchProjectConflict(doc.project_id, check)
    const visible = () => { if (document.visibilityState === 'visible') check() }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', visible)
    const un = () => { stop(); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible) }
    set({ _unwatch: un })
    check()
  },

  /* ---------------- project ops ---------------- */
  createProject: (name) => requestTransition(async () => {
    const st = get()
    const doc = newProjectDoc(uniqueName(name || 'Dự án mới', st.registry.map(m => m.name)))
    doc.layout = defaultLayout(st.settings.defaultLayout as LayoutKind)
    doc.theme_id = st.settings.defaultTheme
    doc.topics[0].text = doc.name
    return writeCandidate('create:' + st.generation + ':' + (name || 'Dự án mới'), doc, true)
  }),
  openProject: (id) => {
    if (get().doc?.project_id === id) return Promise.resolve(true)
    return requestTransition(() => openStored(id))
  },
  renameProject: (name) => {
    const st = get()
    if (st.doc) st.dispatch({ type: 'renameProject', before: st.doc.name, after: name }, 'Đổi tên dự án')
  },
  renameStoredProject: async (id, name) => {
    try {
      const raw = projectRaw(id)
      if (!raw) throw new Error('Dự án không tồn tại')
      const doc = JSON.parse(raw) as ProjectDocV3
      assertUniqueTopicIds(doc.topics)
      const res = applyCommand(doc, { type: 'renameProject', before: doc.name, after: name })
      if (!res.ok) throw new Error(res.error)
      const r = await persistProject(doc, raw)
      if (r.kind !== 'saved') throw new Error(r.message)
      set({ registry: loadRegistry() })
      return true
    } catch (e) { reportError('Đổi tên thất bại', e); return false }
  },
  duplicateProject: async (id) => {
    try {
      const st = get()
      if (st.transitionBusy || st.leavePrompt) return false
      const src = st.doc?.project_id === id ? st.doc : loadProject(id)
      if (!src) throw new Error('Dự án không tồn tại')
      const copy = { ...structuredClone(src), project_id: uuid(), name: uniqueName(`${src.name} (bản sao)`, st.registry.map(m => m.name)), document_revision: 1 }
      const key = 'duplicate:' + id
      const copyId = pendingCandidates.get(key)?.doc.project_id ?? copy.project_id
      const ok = await writeCandidate(key, copy, false)
      if (ok) st.toast('success', 'Đã nhân bản dự án', get().registry.find(m => m.id === copyId)?.name)
      return ok
    } catch (e) { reportError('Nhân bản thất bại', e); return false }
  },
  deleteProject: (id) => {
    const meta = get().registry.find(m => m.id === id)
    let expected: string | null | undefined
    let trashRaw: string | undefined
    let sourceRemoved = false
    get().setConfirm({ message: `Chuyển "${meta?.name ?? id}" vào thùng rác?`, detail: 'Dự án chưa bị xóa vĩnh viễn.', danger: true,
      onOk: () => {
        const run = async () => {
          try {
            await withStorageWrite(() => {
              const st = get()
              const raw = projectRaw(id)
              if (expected === undefined) expected = st.doc?.project_id === id ? st.persistedRaw : raw
              if ((raw !== null && raw !== expected) || (!raw && !trashRaw)) throw new Error('Dự án đã thay đổi hoặc bị xóa ở tab khác.')
              if (raw && !trashList().some(item => item.id === id && JSON.stringify(item.doc) === raw)) pushTrash(JSON.parse(raw))
              const saved = trashList().find(item => item.id === id)
              if (!saved || JSON.stringify(saved.doc) !== (raw ?? trashRaw)) throw new Error('Không xác thực được bản trong thùng rác.')
              trashRaw = JSON.stringify(saved.doc)
              if (raw !== null) localStorage.removeItem(STORAGE_KEYS.project(id))
              if (projectRaw(id) !== null) throw new Error('Không xác thực được thao tác xóa.')
              sourceRemoved = true
              removeMeta(id)
              if (loadRegistry().some(item => item.id === id)) throw new Error('Không cập nhật được danh sách dự án.')
              const settings = loadSettings()
              if (settings.lastProjectId === id) {
                saveSettings({ ...settings, lastProjectId: null })
                if (loadSettings().lastProjectId === id) throw new Error('Không cập nhật được dự án mở gần nhất.')
              }
              clearDraftJournal(id)
              if (readDraftJournal(id)) throw new Error('Không dọn được bản nháp.')
            })
          } catch (error) {
            if (get().doc?.project_id === id) {
              set({ saveStatus: 'error', saveError: String(error) })
              try { if (trashRaw && projectRaw(id) === null) set({ saveStatus: 'conflict' }) } catch { /* storage unavailable */ }
            }
            try { set({ registry: loadRegistry(), settings: loadSettings() }) } catch { /* storage unavailable */ }
            reportError('Chuyển vào thùng rác thất bại', error)
            return false
          }
          if (get().doc?.project_id === id) deactivate()
          set({ registry: loadRegistry(), settings: loadSettings() })
          get().toast('info', 'Đã chuyển vào thùng rác')
          return true
        }
        return requestTransition(run, sourceRemoved || get().doc?.project_id !== id)
      },
    })
  },
  removeRecent: async (id) => {
    try { await withStorageWrite(() => removeMeta(id)); set({ registry: loadRegistry() }); return true }
    catch (e) { reportError('Không cập nhật được danh sách', e); return false }
  },
  openNativeDoc: (doc, options) => {
    try { assertValidImportedProject(doc) }
    catch (e) { reportError('Tệp dự án không hợp lệ', e); return Promise.resolve(false) }
    const st = get()
    const taskId = options?.taskId ?? `oneshot:${doc.project_id}:${uuid()}`
    const verified = verifiedNativeWrites.get(taskId)
    if (!verified && st.doc?.project_id === doc.project_id) {
      const check = inspectNativeImportId(doc, { ignoreUpdatedAt: options?.ignoreUpdatedAt })
      if (check.kind === 'collision') {
        reportError('Không thể mở giữ ID', check.message)
        return Promise.resolve(false)
      }
      if (check.kind === 'equivalent' && !hasUnsaved(st)) {
        return Promise.resolve(true)
      }
    }
    return requestTransition(async () => {
      const entry = verifiedNativeWrites.get(taskId)
      const expectedCandidateRaw = JSON.stringify(doc)
      const canRetryVerified = !!entry && entry.projectId === doc.project_id && entry.candidateRaw === expectedCandidateRaw
      const r = await commitNativeOpen(doc, {
        verifiedRaw: canRetryVerified ? entry.verifiedRaw : undefined,
        ignoreUpdatedAt: options?.ignoreUpdatedAt,
      })
      if (r.kind === 'error') {
        if (r.verifiedRaw) {
          verifiedNativeWrites.set(taskId, { projectId: doc.project_id, candidateRaw: expectedCandidateRaw, verifiedRaw: r.verifiedRaw })
        }
        reportError('Mở dự án nhập thất bại', r.message)
        return false
      }
      if (r.kind === 'conflict') {
        if (r.dropVerified) verifiedNativeWrites.delete(taskId)
        reportError('Xung đột project_id khi nhập', r.message)
        return false
      }
      verifiedNativeWrites.delete(taskId)
      activate(r.doc, r.raw)
      return true
    })
  },
  importOutline: (doc) => requestTransition(async () => {
    assertValidImportedProject(doc)
    const ok = await writeCandidate('import:' + doc.project_id, doc, true)
    if (ok) get().toast('success', 'Đã tạo dự án từ tệp nhập', get().doc!.name)
    return ok
  }),
  closeProject: () => requestTransition(async () => {
    await withStorageWrite(() => saveSettings({ ...loadSettings(), lastProjectId: null }))
    deactivate()
    set({ settings: loadSettings() })
    return true
  }),
  restoreTrash: async (id) => {
    try {
      if (get().transitionBusy || get().leavePrompt) return false
      const item = trashList().find(t => t.id === id)
      if (!item) return false
      const doc = { ...structuredClone(item.doc), project_id: projectRaw(id) ? uuid() : id }
      if (doc.project_id !== id) doc.name += ' (khôi phục)'
      if (!await writeCandidate('trash:' + id, doc, false, true)) return false
      await withStorageWrite(() => removeFromTrash(id))
      const restoredName = pendingCandidates.get('trash:' + id)?.doc.name ?? doc.name
      pendingCandidates.delete('trash:' + id)
      get().toast('success', 'Đã khôi phục dự án', restoredName)
      return true
    } catch (e) { reportError('Khôi phục thất bại', e); return false }
  },
  purgeTrash: async (id) => {
    try { await withStorageWrite(() => removeFromTrash(id)); return true }
    catch (e) { reportError('Xóa thất bại', e); return false }
  },

  /* ---------------- commands (LOCK-06) ---------------- */
  dispatch: (cmd, label) => {
    const st = get()
    if (!st.doc || st.transitionBusy || st.leavePrompt) return false
    if (st.saveStatus === 'conflict') {
      st.toast('warn', 'Đang có xung đột tệp', 'Hãy Tải lại hoặc Lưu thành trước khi chỉnh sửa.')
      return false
    }
    const currentTopic = cmd.type === 'setText' ? getTopic(st.doc, cmd.id) : null
    const titleWillChange = cmd.type === 'setText' && !!currentTopic && currentTopic.text !== cmd.after
    const before = JSON.stringify(st.doc)
    const draft = structuredClone(st.doc)
    const res = applyCommand(draft, cmd)
    if (!res.ok) {
      st.toast('error', res.error ?? 'Lệnh thất bại')
      return false
    }
    try { fitChangedFixedNodes(st.doc, draft) }
    catch (e) { st.toast('error', e instanceof Error ? e.message : 'Không thể tính kích thước node'); return false }
    if (!titleWillChange) {
      const unchanged = { ...draft, document_revision: st.doc.document_revision, updated_at: st.doc.updated_at }
      if (JSON.stringify(unchanged) === before) return true
    }
    const after = JSON.stringify(draft)
    const entry: HistoryEntry = { label, before, after, bytes: utf8ByteLength(after) + utf8ByteLength(before) }
    const past = [...st.past, entry]
    // giới hạn history (19.2): số entry + bộ nhớ
    let total = past.reduce((a, e) => a + e.bytes, 0)
    while (past.length > HISTORY_MAX_ENTRIES || total > HISTORY_MAX_BYTES) {
      const removed = past.shift()
      total -= removed?.bytes ?? 0
      if (!removed) break
    }
    const parentId = cmd.type === 'deleteOnly' ? getTopic(st.doc, cmd.id)?.parent_id : undefined
    const selection = cmd.type === 'deleteOnly'
      ? parentId && getTopic(draft, parentId) ? [parentId] : []
      : pruneSelection(draft, st.selection)
    const keepEditor = st.editor && draft.topics.some((t) => t.id === st.editor!.nodeId) ? st.editor : null
    if (st.editor && !keepEditor) {
      if (st._journalTimer) clearTimeout(st._journalTimer)
      try {
        const journal = readDraftJournal(st.doc.project_id)
        if (journal?.node_id === st.editor.nodeId && journal.field === st.editor.field && journal.draft_text === st.editor.draft) clearDraftJournal(st.doc.project_id)
      } catch { /* storage access must not interrupt the command */ }
    }
    set({ doc: draft, past, future: [], saveStatus: 'dirty', selection, editor: keepEditor, _journalTimer: keepEditor ? st._journalTimer : null })
    get().scheduleAutosave()
    return true
  },
  undo: () => {
    const st = get()
    if (!st.past.length || !st.doc || st.transitionBusy || st.leavePrompt || st.saveStatus === 'conflict') return
    const entry = st.past[st.past.length - 1]
    const curJson = JSON.stringify(st.doc)
    const restored = JSON.parse(entry.before) as ProjectDocV3
    restored.document_revision = st.doc.document_revision + 1 // Undo tạo revision mới (19.1)
    restored.updated_at = new Date().toISOString()
    set({
      doc: restored,
      past: st.past.slice(0, -1),
      // future entry giữ cùng semantics với past entry: before=pre-cmd, after=post-cmd.
      // entry.before = pre-cmd (đang restore về); curJson = post-cmd (đang rời đi).
      future: [...st.future, { label: entry.label, before: entry.before, after: curJson, bytes: entry.bytes }],
      saveStatus: 'dirty',
      selection: pruneSelection(restored, st.selection),
      editor: st.editor && restored.topics.some((t) => t.id === st.editor!.nodeId) ? st.editor : null,
    })
    get().scheduleAutosave()
  },
  redo: () => {
    const st = get()
    if (!st.future.length || !st.doc || st.transitionBusy || st.leavePrompt || st.saveStatus === 'conflict') return
    const entry = st.future[st.future.length - 1]
    const curJson = JSON.stringify(st.doc)
    const restored = JSON.parse(entry.after) as ProjectDocV3
    restored.document_revision = st.doc.document_revision + 1
    restored.updated_at = new Date().toISOString()
    set({
      doc: restored,
      future: st.future.slice(0, -1),
      // past entry: before=pre-cmd, after=post-cmd. curJson=pre-cmd (đang rời đi), entry.after=post-cmd (đang restore về).
      past: [...st.past, { label: entry.label, before: curJson, after: entry.after, bytes: entry.bytes }],
      saveStatus: 'dirty',
      selection: pruneSelection(restored, st.selection),
      editor: st.editor && restored.topics.some((t) => t.id === st.editor!.nodeId) ? st.editor : null,
    })
    get().scheduleAutosave()
  },

  /* ---------------- save (LOCK-09) ---------------- */
  saveNow: () => {
    const st = get()
    if (!st.doc || st.leavePrompt) return Promise.resolve({ kind: 'cancelled' as const })
    if (st.saveStatus === 'conflict') return Promise.resolve({ kind: 'conflict' as const, message: 'Hãy Tải lại hoặc Lưu thành.' })
    if (activeSave) {
      const generation = st.generation
      const raw = JSON.stringify(st.doc)
      if (activeSave.generation === generation && activeSave.raw === raw) return activeSave.promise
      return activeSave.promise.then(result => {
        if (result.kind !== 'saved' || get().generation !== generation) return result
        return get().saveNow()
      })
    }
    const snapshot = structuredClone(st.doc)
    const generation = st.generation
    const raw = JSON.stringify(snapshot)
    let journalRaw: string | null
    try { journalRaw = localStorage.getItem(STORAGE_KEYS.journal(snapshot.project_id)) }
    catch (e) { set({ saveStatus: 'error', saveError: String(e) }); reportError('Lỗi đọc dữ liệu', e); return Promise.resolve({ kind: 'error' as const, message: String(e) }) }
    if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
    set({ saveStatus: 'saving', _autosaveTimer: null })
    const promise = (async (): Promise<SaveResult> => {
      const r = await persistProject(snapshot, st.persistedRaw, { backupCount: st.settings.backupCount })
      if (get().generation !== generation) return { kind: 'cancelled' }
      if (r.kind === 'error') {
        if (r.writtenRaw !== undefined) set({ persistedRaw: r.writtenRaw })
        set({ saveStatus: 'error', saveError: r.message })
        get().toast('error', 'Lỗi lưu', r.message + '. Nội dung vẫn được giữ; hãy thử lại hoặc Xuất.')
        return { kind: 'error', message: r.message }
      }
      if (r.kind === 'conflict') {
        set({ saveStatus: 'conflict' })
        get().toast('warn', 'Xung đột tệp', r.message)
        return r
      }
      const stillDirty = JSON.stringify(get().doc) !== raw
      set({ persistedRaw: r.raw, savedHash: simpleHash(raw), registry: loadRegistry(), saveStatus: stillDirty ? 'dirty' : 'clean', saveError: null })
      if (journalRaw && localStorage.getItem(STORAGE_KEYS.journal(snapshot.project_id)) === journalRaw) {
        const j = JSON.parse(journalRaw)
        const node = snapshot.topics.find(t => t.id === j.node_id)
        if ((node && (j.field === 'title' ? node.text : node.notes ?? '') === j.draft_text || ownedCommittedJournals.get(snapshot.project_id) === journalRaw && snapshot.document_revision > j.base_document_revision) && !(get().editor?.draft !== get().editor?.baseText)) {
          clearDraftJournal(snapshot.project_id)
          ownedCommittedJournals.delete(snapshot.project_id)
        }
      }
      if (stillDirty && get().settings.autosaveEnabled) get().scheduleAutosave()
      return { kind: 'saved', projectId: snapshot.project_id, revision: snapshot.document_revision, stillDirty }
    })().catch((e): SaveResult => {
      if (get().generation === generation) { set({ saveStatus: 'error', saveError: String(e) }); reportError('Lỗi lưu', e) }
      return { kind: 'error', message: String(e) }
    }).finally(() => { if (activeSave?.promise === promise) activeSave = null })
    activeSave = { generation, raw, promise }
    return promise
  },
  scheduleAutosave: () => {
    const st = get()
    if (st.saveStatus === 'conflict') return
    if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
    set({ saveStatus: 'dirty', _autosaveTimer: null })
    if (!st.settings.autosaveEnabled || !st.doc || st.transitionBusy || st.leavePrompt) return
    const generation = st.generation
    const timer = setTimeout(() => {
      if (get().generation === generation && get().saveStatus === 'dirty') void get().saveNow()
    }, st.settings.autosaveIntervalMs)
    set({ _autosaveTimer: timer })
  },
  resolveConflictReload: () => requestTransition(async () => {
    if (!get().doc) return false
    const ok = await openStored(get().doc!.project_id)
    if (ok) get().toast('info', 'Đã tải lại từ đĩa')
    return ok
  }, true),
  resolveConflictSaveAs: () => requestTransition(async () => {
    const st = get()
    if (!st.doc) return false
    const copy = { ...structuredClone(st.doc), project_id: uuid(), name: `${st.doc.name} (bản sửa xung đột)`, document_revision: 1 }
    if (st.editor) {
      const node = getTopic(copy, st.editor.nodeId)
      if (node) { if (st.editor.field === 'title') node.text = st.editor.draft; else node.notes = st.editor.draft }
    }
    const ok = await writeCandidate('saveas:' + st.generation, copy, true)
    if (ok) get().toast('success', 'Đã lưu thành bản sao mới', get().doc!.name)
    return ok
  }, true),

  /* ---------------- view ---------------- */
  setCamera: (c) => {
    set({ camera: c })
    const st = get()
    if (st.doc) {
      const camera = { ...c }
      if (_camSaveTimer) clearTimeout(_camSaveTimer)
      const pid = st.doc.project_id
      _flushCamera = () => saveSession(pid, { camera })
      _camSaveTimer = setTimeout(flushCameraSession, 250)
    }
  },
  setSelection: (ids) => {
    if (get().editor && !get().commitEdit()) return
    set({ selection: ids })
  },
  toggleSelection: (id, additive) => {
    const st = get()
    if (st.editor && !st.commitEdit()) return
    if (!additive) set({ selection: [id] })
    else set({ selection: st.selection.includes(id) ? st.selection.filter((x) => x !== id) : [...st.selection, id] })
  },
  setTool: (t) => set({ tool: t, drawMode: t !== 'select' ? true : get().drawMode }),
  setDrawMode: (v) => set({ drawMode: v, tool: v ? 'pen' : 'select' }),
  setBrush: (b) => set({ brush: { ...get().brush, ...b } }),
  setSidebar: (s) => set({ sidebar: s }),
  setInspector: (open, tab) => {
    if ((!open || tab && tab !== get().inspectorTab) && get().editor && !get().commitEdit()) return
    set({ inspectorOpen: open, inspectorTab: tab ?? get().inspectorTab })
  },
  setMinimap: (v) => set({ minimapOn: v }),
  setGrid: (v) => set({ gridOn: v }),
  setSnap: (v) => set({ snapOn: v }),
  focusBranch: (id) => {
    const st = get()
    set({ focusRootId: id, cameraBeforeFocus: st.camera })
  },
  exitFocus: () => {
    const st = get()
    set({ focusRootId: null, camera: st.cameraBeforeFocus ?? st.camera })
  },
  openSearch: (v) => set({ search: { ...get().search, open: v, index: 0, matches: v ? get().search.matches : [] } }),
  setSearch: (s) => set({ search: { ...get().search, ...s } }),
  setSettings: async (patch) => {
    try {
      let settings!: AppSettings
      await withStorageWrite(() => {
        settings = { ...loadSettings(), ...patch }; saveSettings(settings)
        if (JSON.stringify(loadSettings()) !== JSON.stringify(settings)) throw new Error('Xác thực ghi cài đặt thất bại')
      })
      set({ settings })
      if (patch.appearance) applyAppearance(settings.appearance)
      if (patch.reduceMotion !== undefined) applyReduceMotion(settings.reduceMotion)
      return true
    } catch (e) { reportError('Lỗi lưu cài đặt', e); return false }
  },
  resetSettingsGroup: async (group) => {
    const d = defaultSettings()
    const st = get()
    const patch: Partial<AppSettings> =
      group === 'general' ? { appearance: d.appearance, reduceMotion: d.reduceMotion, helpTooltips: d.helpTooltips }
      : group === 'map' ? { defaultLayout: d.defaultLayout, defaultTheme: d.defaultTheme }
      : group === 'canvas' ? { gridVisible: d.gridVisible, gridSpacing: d.gridSpacing, snapToGrid: d.snapToGrid, minimapDefault: d.minimapDefault }
      : { autosaveEnabled: d.autosaveEnabled, autosaveIntervalMs: d.autosaveIntervalMs, backupCount: d.backupCount, draftJournalEnabled: d.draftJournalEnabled }
    if (await get().setSettings(patch)) st.toast('info', 'Đã đặt lại nhóm cài đặt')
  },

  /* ---------------- editor + draft journal (17.3) ---------------- */
  startEdit: (nodeId, field) => {
    const st = get()
    const t = st.doc && getTopic(st.doc, nodeId)
    if (!t || st.transitionBusy || st.leavePrompt || st.saveStatus === 'conflict') return
    if (st.editor?.nodeId === nodeId && st.editor.field === field) return
    if (st.editor && !st.commitEdit()) return
    const current = getTopic(get().doc!, nodeId)!
    const baseText = field === 'title' ? current.text : (current.notes ?? '')
    set({ editor: { nodeId, field, draft: baseText, baseText } })
  },
  updateDraft: (text) => {
    const st = get()
    if (!st.editor || st.transitionBusy || st.leavePrompt) return
    set({ editor: { ...st.editor, draft: text } })
    if (!st.settings.draftJournalEnabled || !st.doc) return
    if (st._journalTimer) clearTimeout(st._journalTimer)
    const generation = st.generation
    const editor = { ...st.editor, draft: text }
    const projectId = st.doc.project_id
    const revision = st.doc.document_revision
    const t = setTimeout(() => {
      if (get().generation !== generation || get().transitionBusy || get().editor?.nodeId !== editor.nodeId || get().editor?.draft !== editor.draft) return
      writeDraftJournal({ journal_schema_version: 1, project_id: projectId, node_id: editor.nodeId, field: editor.field, base_document_revision: revision, base_field_value: editor.baseText, draft_text: editor.draft, timestamp: new Date().toISOString() })
    }, 500)
    set({ _journalTimer: t })
  },
  commitEdit: () => {
    const st = get()
    if (!st.editor) return true
    if (!st.doc) return false
    const { nodeId, field, draft, baseText } = st.editor
    const t = getTopic(st.doc, nodeId)
    if (!t) return false
    let final = draft
    // trim newline đầu/cuối giữ khoảng trắng trong đoạn (04.3)
    if (field === 'title') final = draft.replace(/^\n+|\n+$/g, '')
    if (!final.trim() && field === 'title' && t.text.trim()) {
      // xóa toàn bộ text node cũ → hỏi xác nhận; đơn giản: giữ "Chủ đề"
      final = 'Chủ đề'
    }
    if (st.transitionBusy || st.leavePrompt || st.saveStatus === 'conflict') return false
    if (st._journalTimer) clearTimeout(st._journalTimer)
    let committedJournal: string | null = null
    if (st.settings.draftJournalEnabled && final !== baseText) {
      const journal = { journal_schema_version: 1 as const, project_id: st.doc.project_id, node_id: nodeId, field, base_document_revision: st.doc.document_revision, base_field_value: baseText, draft_text: final, timestamp: new Date().toISOString() }
      writeDraftJournal(journal)
      committedJournal = JSON.stringify(journal)
    }
    if (final !== baseText) {
      const ok = field === 'title' ? get().dispatch({ type: 'setText', id: nodeId, before: baseText, after: final }, 'Sửa tiêu đề')
      : get().dispatch({ type: 'setProps', id: nodeId, before: { notes: baseText || null }, after: { notes: final || null } }, 'Sửa ghi chú')
      if (!ok) { set({ _journalTimer: null }); return false }
    }
    if (committedJournal) {
      try { if (localStorage.getItem(STORAGE_KEYS.journal(st.doc.project_id)) === committedJournal) ownedCommittedJournals.set(st.doc.project_id, committedJournal) } catch { /* draft protection cannot block an in-memory commit */ }
    }
    set({ editor: null, _journalTimer: null })
    return true
  },
  cancelEdit: () => {
    const st = get()
    if (st._journalTimer) clearTimeout(st._journalTimer)
    if (st.doc && st.editor) {
      const j = readDraftJournal(st.doc.project_id)
      if (j?.node_id === st.editor.nodeId && j.field === st.editor.field && j.draft_text === st.editor.draft) clearDraftJournal(st.doc.project_id)
    }
    set({ editor: null, _journalTimer: null })
  },

  /* ---------------- dialogs ---------------- */
  setImportOpen: (v) => set({ importOpen: v }),
  openExport: (scopeRootId) => set({ exportOpen: { open: true, optionsRevision: null, scopeRootId: scopeRootId ?? null } }),
  closeExport: () => set({ exportOpen: null }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  dismissRecovery: (i) => {
    const st = get()
    if (st.transitionBusy || st.leavePrompt) return
    const c = st.recovery.candidates[i]
    if (c?.draft && JSON.stringify(readDraftJournal(c.projectId)) === JSON.stringify(c.draft)) clearDraftJournal(c.projectId)
    const candidates = st.recovery.candidates.filter((_, j) => j !== i)
    set({ recovery: { open: candidates.length > 0, candidates } })
  },
  applyRecovery: (i, asCopy) => requestTransition(async () => {
    const c = get().recovery.candidates[i]
    if (!c) return false
    const copy = asCopy || c.kind === 'backup'
    const doc = structuredClone(c.doc)
    if (!copy && (!c.baseRaw || c.draft?.base_field_value === undefined)) {
      get().toast('warn', 'Hãy khôi phục thành bản sao', 'Không xác minh được bản nền của bản nháp.')
      return false
    }
    if (asCopy || c.kind === 'backup') { doc.project_id = uuid(); doc.name += ' (khôi phục)' }
    if (c.draft) {
      const node = getTopic(doc, c.draft.node_id)
      if (!node) throw new Error('Node của bản nháp không còn tồn tại')
      if (!copy && (c.draft.field === 'title' ? node.text : node.notes ?? '') !== c.draft.base_field_value) {
        get().toast('warn', 'Hãy khôi phục thành bản sao', 'Nội dung gốc đã thay đổi.')
        return false
      }
      if (c.draft.field === 'title') node.text = c.draft.draft_text
      else node.notes = c.draft.draft_text
    }
    const key = 'recovery:' + c.projectId + ':' + (c.draft?.timestamp ?? c.timestamp) + ':' + (copy ? 'copy' : 'source')
    const pending = pendingCandidates.get(key)
    doc.document_revision += 1
    doc.updated_at = pending?.doc.updated_at ?? new Date().toISOString()
    if (!await writeCandidate(key, doc, true, true, copy ? null : c.baseRaw!)) return false
    await withStorageWrite(() => {
      const j = readDraftJournal(c.projectId)
      if (c.draft && JSON.stringify(j) === JSON.stringify(c.draft)) clearDraftJournal(c.projectId)
    })
    pendingCandidates.delete(key)
    const candidates = get().recovery.candidates.filter((_, index) => index !== i)
    set({ recovery: { open: candidates.length > 0, candidates } })
    get().toast('success', 'Đã khôi phục dự án', get().doc!.name)
    return true
  }),
  setConfirm: (c) => set({ confirm: c }),
  setLayoutPicker: (v) => set({ layoutPickerOpen: v }),
  setThemePicker: (v) => set({ themePickerOpen: v }),
  toast: (severity, text, detail) => {
    const id = uuid()
    set({ toasts: [...get().toasts.slice(-4), { id, severity, text, detail }] })
    setTimeout(() => get().dismissToast(id), detail ? 9000 : 4000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  /* ---------------- helpers ---------------- */
  applyLayoutKind: (kind) => {
    const st = get()
    if (!st.doc) return
    st.dispatch({ type: 'setLayout', before: st.doc.layout, after: { ...defaultLayout(kind), start_angle_deg: st.doc.layout.start_angle_deg, chronological: st.doc.layout.chronological, sort_policy: st.doc.layout.sort_policy, snap_to_grid: st.doc.layout.snap_to_grid } }, 'Đổi bố cục')
  },
  addNode: (parentId, text, opts) => {
    const st = get()
    if (!st.doc) return null
    // parentId === null luôn hiểu là "thêm con cho Chủ đề trung tâm" (nhất quán
    // với addChildToSelection và với bước tra cứu ID bên dưới).
    const targetPid = parentId ?? st.doc.central_topic_id
    const cmd = cmdBuilders.addChild(st.doc, targetPid, text ?? 'Chủ đề mới', opts?.index ?? null)
    const ok = st.dispatch(cmd, 'Thêm chủ đề')
    if (ok) {
      // QUAN TRỌNG: dùng get().doc (state mới sau dispatch) chứ không phải st.doc (stale).
      const fresh = get().doc!
      const kids = childrenOf(fresh, targetPid)
      return kids[kids.length - 1]?.id ?? null
    }
    return null
  },
  addChildToSelection: () => {
    const st = get()
    if (!st.doc) return
    const target = st.selection[0] ?? st.doc.central_topic_id
    const id = get().addNode(target)
    if (id) {
      set({ selection: [id] })
      setTimeout(() => get().startEdit(id, 'title'), 30)
    }
  },
  addSiblingToSelection: (before) => {
    const st = get()
    if (!st.doc || !st.selection[0]) { get().addChildToSelection(); return }
    const refId = st.selection[0]
    const cmd = cmdBuilders.addSibling(st.doc, refId, before)
    if (cmd && cmd.type === 'addTopic') {
      if (st.dispatch(cmd, 'Thêm chủ đề ngang hàng')) {
        // cmd.topic.id là ID của node mới (đã có trong doc sau dispatch).
        // Cách này hoạt động cho cả trường hợp ref=central (addSibling trả addChild)
        // lẫn ref=normal (addSibling trả addTopic với parentId=ref.parent_id).
        const newId = cmd.topic.id
        const fresh = get().doc!
        if (getTopic(fresh, newId)) {
          set({ selection: [newId] })
          setTimeout(() => get().startEdit(newId, 'title'), 30)
        }
      }
    }
  },
  deleteSelection: () => {
    const st = get()
    if (!st.doc || !st.selection.length) return
    const total = st.selection.reduce((a, id) => a + (getTopic(st.doc!, id) ? subtreeSize(st.doc!, id) : 0), 0)
    const run = () => {
      const ok = get().dispatch({ type: 'deleteTopics', ids: [...st.selection] }, 'Xóa chủ đề')
      if (ok) set({ selection: [] })
    }
    if (total > 20) {
      st.setConfirm({ message: `Xóa ${total} node?`, detail: 'Thao tác có thể hoàn tác bằng Ctrl+Z.', danger: true, onOk: run })
    } else run()
  },
  duplicateSelection: () => {
    const st = get()
    if (!st.doc || !st.selection[0]) return
    const src = getTopic(st.doc, st.selection[0])
    if (!src) return
    if (src.id === st.doc.central_topic_id || src.role === 'central') {
      st.toast('warn', 'Không thể nhân bản Chủ đề trung tâm')
      return
    }
    let resolvedPositions: Record<string, { x: number; y: number }> | undefined
    if (st.doc.layout.kind === 'freeform' && typeof document !== 'undefined') {
      const pos = buildScene(st.doc).layoutResult.pos
      resolvedPositions = {}
      pos.forEach((b, id) => { resolvedPositions![id] = { x: b.x, y: b.y } })
    }
    if (st.dispatch({ type: 'duplicateSubtree', id: src.id, resolvedPositions }, 'Nhân bản nhánh')) {
      // Dùng state mới (st.doc đã stale sau dispatch).
      const fresh = get().doc!
      const t = getTopic(fresh, src.id)
      if (t) {
        const sibs = childrenOf(fresh, t.parent_id)
        if (sibs.length) set({ selection: [sibs[sibs.length - 1].id] })
      }
    }
  },
}))

let activeSave: { generation: number; raw: string; promise: Promise<SaveResult> } | null = null
const ownedCommittedJournals = new Map<string, string>()
const pendingCandidates = new Map<string, { doc: ProjectDocV3; raw: string | null }>()
const verifiedNativeWrites = new Map<string, { projectId: string; candidateRaw: string; verifiedRaw: string }>()

function reportError(title: string, error: unknown) {
  useApp.getState().toast('error', title, error instanceof Error ? error.message : String(error))
}
function hasUnsaved(st: AppState): boolean {
  return !!st.doc && (st.saveStatus !== 'clean' || !!st.editor && st.editor.draft !== st.editor.baseText)
}
function flushCameraSession() {
  if (_camSaveTimer) clearTimeout(_camSaveTimer)
  _camSaveTimer = null
  _flushCamera?.()
  _flushCamera = undefined
}
function stopProjectTimers() {
  const st = useApp.getState()
  if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
  if (st._journalTimer) clearTimeout(st._journalTimer)
  flushCameraSession()
  st._unwatch?.()
}
function deactivate() {
  stopProjectTimers()
  useApp.setState(st => ({ doc: null, editor: null, exportOpen: null, generation: st.generation + 1, persistedRaw: null, savedHash: null, saveStatus: 'none', saveError: null, past: [], future: [], selection: [], focusRootId: null, _autosaveTimer: null, _journalTimer: null, _unwatch: null }))
}
function activate(doc: ProjectDocV3, raw: string) {
  assertUniqueTopicIds(doc.topics)
  stopProjectTimers()
  const session = loadSession(doc.project_id)
  useApp.setState(st => ({ doc: structuredClone(doc), generation: st.generation + 1, persistedRaw: raw, savedHash: simpleHash(raw), saveStatus: 'clean', saveError: null, settings: loadSettings(), registry: loadRegistry(), editor: null, exportOpen: null, past: [], future: [], selection: [], focusRootId: null, camera: session?.camera ?? { x: 0, y: 0, zoom: 1 }, search: { ...st.search, open: false, matches: [] }, _autosaveTimer: null, _journalTimer: null }))
  useApp.getState()._startWatch()
}
async function openStored(id: string): Promise<boolean> {
  const raw = projectRaw(id)
  if (!raw) throw new Error('Dự án không tồn tại hoặc đã bị xóa')
  const doc = readStoredProject(raw, id)
  if (!doc) throw new Error('Dữ liệu dự án không hợp lệ')
  if (typeof navigator === 'undefined' || !navigator.locks) {
    activate(doc, raw)
    useApp.setState({ saveStatus: 'error', saveError: 'Môi trường không hỗ trợ khóa ghi. Nội dung đang ở RAM và có thể Xuất.' })
    reportError('Không thể ghi an toàn', 'Hãy dùng localhost/HTTPS và trình duyệt hỗ trợ Web Locks. Bạn vẫn có thể Xuất nội dung.')
    return true
  }
  const result = await persistProject(doc, raw, { activate: true })
  if (result.kind !== 'saved') throw new Error(result.message)
  activate(doc, raw)
  return true
}
async function writeCandidate(key: string, doc: ProjectDocV3, makeActive: boolean, keep = false, expected: string | null = null): Promise<boolean> {
  assertUniqueTopicIds(doc.topics)
  let candidate = pendingCandidates.get(key)
  if (!candidate) {
    candidate = { doc: structuredClone(doc), raw: expected }
    pendingCandidates.set(key, candidate)
  }
  candidate.doc = { ...structuredClone(doc), project_id: candidate.doc.project_id, name: candidate.doc.name }
  const r = await persistProject(candidate.doc, candidate.raw, { activate: makeActive })
  if (r.kind === 'error' && r.writtenRaw !== undefined) {
    candidate.raw = r.writtenRaw
    if (useApp.getState().doc?.project_id === candidate.doc.project_id) useApp.setState({ persistedRaw: r.writtenRaw, saveStatus: 'error', saveError: r.message })
  }
  if (r.kind !== 'saved') { reportError('Lưu dự án thất bại', r.message); return false }
  candidate.raw = r.raw
  if (makeActive) activate(candidate.doc, r.raw)
  else useApp.setState({ registry: loadRegistry() })
  if (!keep) pendingCandidates.delete(key)
  return true
}
function requestTransition(run: () => Promise<boolean>, skipGuard = false): Promise<boolean> {
  const st = useApp.getState()
  if (st.transitionBusy || st.leavePrompt) return Promise.resolve(false)
  if (!skipGuard && hasUnsaved(st)) {
    if (st.saveStatus === 'conflict') {
      st.toast('warn', 'Đang có xung đột tệp', 'Hãy Tải lại hoặc Lưu thành trước khi chuyển dự án.')
      return Promise.resolve(false)
    }
    if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
    return new Promise(resolve => useApp.setState({ leavePrompt: { run, resolve }, _autosaveTimer: null }))
  }
  return executeTransition(run, false)
}
async function executeTransition(run: () => Promise<boolean>, save: boolean): Promise<boolean> {
  const source = useApp.getState()
  let journal: string | null = null
  try {
    if (source.doc) journal = localStorage.getItem(STORAGE_KEYS.journal(source.doc.project_id))
    if (save) {
      if (!source.commitEdit()) return false
    }
    useApp.setState({ transitionBusy: true })
    if (save) {
      const result = await useApp.getState().saveNow()
      if (result.kind !== 'saved' || result.stillDirty) return false
    } else if (activeSave?.generation === source.generation) await activeSave.promise
    const ok = await run()
    if (ok && source.doc && useApp.getState().generation !== source.generation && journal && localStorage.getItem(STORAGE_KEYS.journal(source.doc.project_id)) === journal) clearDraftJournal(source.doc.project_id)
    return ok
  } catch (e) { reportError('Không thể hoàn tất thao tác', e); return false }
  finally {
    useApp.setState({ transitionBusy: false })
    const st = useApp.getState()
    if (st.saveStatus === 'dirty' && !st.leavePrompt) st.scheduleAutosave()
  }
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base
  let i = 2
  while (existing.includes(`${base} (${i})`)) i++
  return `${base} (${i})`
}

let stopAppearanceWatch: (() => void) | undefined
function applyAppearance(mode: 'system' | 'light' | 'dark') {
  if (typeof document === 'undefined') return
  stopAppearanceWatch?.()
  stopAppearanceWatch = undefined
  const root = document.documentElement
  const media = mode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  const update = () => {
    const dark = mode === 'dark' || !!media?.matches
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
  }
  update()
  if (media?.addEventListener) {
    media.addEventListener('change', update)
    stopAppearanceWatch = () => media.removeEventListener('change', update)
  }
}

/* Giảm chuyển động (Cài đặt → Chung): tắt animation trang trí (.omm-fade-in —
 * animation duy nhất của app), không đụng transition chức năng. */
function applyReduceMotion(on: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('omm-reduce-motion', on)
}

export type NativeCloseDecision =
  | { decision: 'allow-clean'; projectName: string | null }
  | { decision: 'busy'; message: string }
  | { decision: 'conflict'; message: string }
  | { decision: 'confirm-dirty'; projectName: string; saveStatus: SaveStatus; generation: number }

export function inspectNativeCloseState(): NativeCloseDecision {
  const st = useApp.getState()
  if (!st.hydrated) return { decision: 'allow-clean', projectName: null }
  if (st.transitionBusy || st.leavePrompt) {
    return { decision: 'busy', message: 'Đang có thao tác lưu hoặc chuyển dự án khác.' }
  }
  if (st.doc) {
    if (st.saveStatus === 'conflict' || projectRaw(st.doc.project_id) !== st.persistedRaw) {
      if (st.saveStatus !== 'conflict') {
        st.toast('warn', 'Xung đột tệp', 'Dự án đã thay đổi hoặc bị xóa ở phiên khác. Chọn Tải lại hoặc Lưu thành.')
        useApp.setState({ saveStatus: 'conflict' })
      }
      return { decision: 'conflict', message: 'Dự án đang có xung đột tệp. Hãy chọn Tải lại hoặc Lưu thành trước khi đóng.' }
    }
  }
  const hasInFlightSave = !!(activeSave && activeSave.generation === st.generation)
  if (hasUnsaved(st) || hasInFlightSave) {
    if (st._autosaveTimer) {
      clearTimeout(st._autosaveTimer)
      useApp.setState({ _autosaveTimer: null })
    }
    return {
      decision: 'confirm-dirty',
      projectName: st.doc?.name ?? 'Dự án',
      saveStatus: st.saveStatus,
      generation: st.generation,
    }
  }
  return { decision: 'allow-clean', projectName: st.doc?.name ?? null }
}

export function finalizeNativeCleanClose(): { ok: true } {
  const st = useApp.getState()
  if (st.doc) {
    saveSession(st.doc.project_id, { camera: st.camera })
  }
  flushCameraSession()
  try { markCleanShutdown() } catch { /* ignore storage unavailable */ }
  return { ok: true }
}

export async function commitAndFlushNativeClose(): Promise<{ ok: true } | { ok: false; kind?: string; error: string }> {
  const st = useApp.getState()
  if (!st.doc) return finalizeNativeCleanClose()
  if (st.transitionBusy || st.leavePrompt) {
    return { ok: false, error: 'Đang có thao tác khác đang chạy.' }
  }
  if (st.editor && !st.commitEdit()) {
    return { ok: false, error: 'Không thể áp dụng nội dung đang soạn trước khi lưu.' }
  }
  const cur = useApp.getState()
  const needsSave = hasUnsaved(cur) || (activeSave && activeSave.generation === cur.generation)
  if (needsSave) {
    const result = await cur.saveNow()
    const after = useApp.getState()
    if (result.kind !== 'saved' || result.stillDirty || after.saveStatus !== 'clean') {
      const fallback = result.kind === 'conflict'
        ? 'Dự án đang có xung đột tệp. Hãy Lưu thành bản sao trước khi đóng.'
        : (result.kind === 'error' ? result.message : null) ?? after.saveError ?? 'Không thể lưu dự án an toàn.'
      return { ok: false, kind: result.kind, error: fallback }
    }
  }
  return finalizeNativeCleanClose()
}

export async function discardAndPrepareNativeClose(): Promise<{ ok: true }> {
  const st = useApp.getState()
  if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
  if (st._journalTimer) clearTimeout(st._journalTimer)
  useApp.setState({ _autosaveTimer: null, _journalTimer: null })
  if (activeSave && activeSave.generation === st.generation) {
    try { await activeSave.promise } catch { /* discard path proceeds cleanly after active lock releases */ }
  }
  const after = useApp.getState()
  if (after.doc) {
    saveSession(after.doc.project_id, { camera: after.camera })
    flushCameraSession()
    clearDraftJournal(after.doc.project_id)
    const diskDoc = loadProject(after.doc.project_id)
    if (diskDoc) {
      useApp.setState({ doc: diskDoc, saveStatus: 'clean' })
    }
  } else {
    flushCameraSession()
  }
  useApp.setState({ editor: null })
  try { markCleanShutdown() } catch { /* ignore */ }
  return { ok: true }
}

export function cancelNativeClose(): { ok: true } {
  const st = useApp.getState()
  if (st.saveStatus === 'dirty' && !st.leavePrompt) {
    st.scheduleAutosave()
  }
  return { ok: true }
}

/* helper không thuộc store nhưng dùng chung */
export { getTopic }

// Expose store on window for E2E verification & Native bridge testing.
if (typeof window !== 'undefined' && (process.env.NODE_ENV !== 'production' || (window as unknown as { __OMM_NATIVE_MACOS__?: boolean }).__OMM_NATIVE_MACOS__)) {
  ;(window as unknown as { __ommUseApp?: typeof useApp }).__ommUseApp = useApp
  ;(window as unknown as { __ommCmdBuilders?: typeof cmdBuilders }).__ommCmdBuilders = cmdBuilders
  // Cầu nối IO (dev-only) phục vụ kiểm chứng import/export E2E — không ảnh hưởng bản production.
  void Promise.all([import('./io/exporters'), import('./io/importers')]).then(([ex, im]) => {
    ;(window as unknown as { __ommIO?: unknown }).__ommIO = { ...ex, ...im }
  })
}
