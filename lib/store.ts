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
  loadRegistry, saveRegistry, removeMeta, loadProject, readStoredProject, metaFromDoc, upsertMeta, saveProjectAtomic,
  pushTrash, saveSession, loadSession, writeDraftJournal, clearDraftJournal,
  watchProjectConflict, markCleanShutdown, clearCleanShutdownFlag, collectRecoveryCandidates,
  RecoveryCandidate, simpleHash, readDraftJournal, trashList, removeFromTrash, saveTrashList, isSameTrashItem, isTrashRestorePending, type TrashItem, type ProjectMeta, type DraftJournalRecord, STORAGE_KEYS,
} from './storage/projects'
import { commitNativeOpen, inspectNativeImportId, persistProject, persistProjectLocked, projectRaw, withStorageWrite, writeAndVerifyMetadata } from './storage/persistence'

export type SaveStatus = 'none' | 'clean' | 'dirty' | 'saving' | 'error' | 'conflict'
export type SaveResult = { kind: 'saved'; projectId: string; revision: number; stillDirty: boolean } | { kind: 'error' | 'conflict' | 'cancelled'; message?: string }
export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'rect' | 'ellipse'

/* Debounce ghi session camera: pan/zoom phát ~120 sự kiện/giây — ghi localStorage
 * từng frame làm khựng chuyển động. Chỉ ghi sau khi dừng 250ms (vẫn khôi phục
 * camera phiên bình thường, tối đa mất 250ms vị trí cuối khi đóng đột ngột). */
let _camSaveTimer: ReturnType<typeof setTimeout> | null = null
let _flushCamera: (() => Promise<boolean>) | undefined

export interface Toast { id: string; severity: 'info' | 'warn' | 'error' | 'success'; text: string; detail?: string }
export interface EditorState { sessionId: string; nodeId: string; field: 'title' | 'notes'; draft: string; baseText: string }
export interface ExportDialogState { open: boolean; optionsRevision: number | null; scopeRootId?: string | null }
export interface ImportDialogState { open: boolean }

const HISTORY_MAX_ENTRIES = 150
const HISTORY_MAX_BYTES = 48 * 1024 * 1024
const utf8Encoder = new TextEncoder()
const utf8ByteLength = (s: string) => utf8Encoder.encode(s).length

interface HistoryEntry { label: string; before: string; after: string; bytes: number }
export type ProjectRenameTarget = {
  id: string
  storageEpoch?: string
  legacy?: { raw: string; generation: number }
}

export interface AppState {
  persistedRaw: string | null
  generation: number
  transitionBusy: boolean
  leavePrompt: { run: () => Promise<boolean>; resolve: (ok: boolean) => void } | null
  chooseLeave: (choice: 'save' | 'discard' | 'cancel') => Promise<void>
  restoreTrash: (item: TrashItem) => Promise<boolean>
  purgeTrash: (item: TrashItem) => Promise<boolean>
  renameStoredProject: (id: string, name: string, target?: Omit<ProjectRenameTarget, 'id'>) => Promise<boolean>
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
  cameraReady: boolean
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
  renameProject: (name: string) => boolean
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
  dismissRecovery: (i: number) => Promise<void>
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
  cameraReady: false,
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
      if (loadProject(last.id)) void requestTransition(() => openStored(last.id, false))
      else unreadable.add(last.id)
    }
    if (unreadable.size) get().toast('warn', 'Một số dữ liệu không đọc được', [...unreadable].map(id => registry.find(m => m.id === id)?.name ?? id).join(', '))
    window.addEventListener('pagehide', flushCameraSession)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushCameraSession()
    })
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
        if (cur.doc?.project_id === doc.project_id && (projectRaw(doc.project_id) !== cur.persistedRaw
          || loadRegistry().find(item => item.id === doc.project_id)?.storageEpoch !== projectEpoch(cur, doc.project_id))) {
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
  openProject: async (id) => {
    const st = get()
    if (st.doc?.project_id !== id) return requestTransition(() => openStored(id, true))
    if (st.transitionBusy || st.leavePrompt) return false
    try {
      await setRecentVisibility(id, false, { generation: st.generation, epoch: projectEpoch(st, id) })
      return true
    } catch (error) {
      reportError('Không cập nhật được danh sách', error)
      return false
    }
  },
  renameProject: (name) => {
    const st = get()
    return !!st.doc && st.dispatch({ type: 'renameProject', before: st.doc.name, after: name }, 'Đổi tên dự án')
  },
  renameStoredProject: async (id, name, target) => {
    try {
      const original = projectRaw(id)
      const expected = target ?? loadRegistry().find(meta => meta.id === id)
      return await withStorageWrite(() => {
        const registry = loadRegistry()
        const meta = registry.find(entry => entry.id === id)
        const raw = projectRaw(id)
        const st = get()
        const legacy = target?.legacy
        const identity = activeProjectIdentity
        const openedLegacyHere = legacy && expected?.storageEpoch === undefined
          && meta?.storageEpoch !== undefined && st.doc?.project_id === id
          && identity?.id === id && identity.epoch === meta.storageEpoch
          && identity.generation === st.generation && st.generation === legacy.generation + 1
          && identity.initialEpochRaw === raw && legacy.raw === raw
        if (!expected || !meta || (meta.storageEpoch !== expected.storageEpoch && !openedLegacyHere)
          || !raw || raw !== original || (legacy && legacy.raw !== raw)
          || isTrashRestorePending(id, meta.storageEpoch)
          || (st.doc?.project_id === id && (projectEpoch(st, id) !== meta.storageEpoch || st.persistedRaw !== raw))) {
          set({ registry })
          throw new Error('Dự án đã thay đổi hoặc đang khôi phục. Hãy chọn lại dự án trước khi đổi tên.')
        }
        if (st.doc?.project_id === id) return st.renameProject(name)
        const doc = readStoredProject(raw, id)
        if (!doc) throw new Error('Dữ liệu dự án không hợp lệ.')
        const res = applyCommand(doc, { type: 'renameProject', before: doc.name, after: name })
        if (!res.ok) throw new Error(res.error)
        const result = persistProjectLocked(doc, raw, { identity: { storageEpoch: meta.storageEpoch } })
        if (result.kind !== 'saved') throw new Error(result.message)
        set({ registry: loadRegistry() })
        return true
      })
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
    const meta = loadRegistry().find(m => m.id === id)
    let expected: string | null | undefined
    let trashed: TrashItem | undefined
    let sourceRemoved = false
    get().setConfirm({ message: `Chuyển "${meta?.name ?? id}" vào thùng rác?`, detail: 'Dự án chưa bị xóa vĩnh viễn.', danger: true,
      onOk: () => {
        const run = async () => {
          const source = get()
          try {
            await withStorageWrite(() => {
              const st = get()
              try {
                const raw = projectRaw(id)
                if (expected === undefined) expected = st.doc?.project_id === id ? st.persistedRaw : raw
                const storedMeta = loadRegistry().find(meta => meta.id === id)
                if (isTrashRestorePending(id, storedMeta?.storageEpoch)) throw new Error(pendingTrashRestoreMessage)
                if ((raw !== null && (raw !== expected || storedMeta?.storageEpoch !== meta?.storageEpoch
                  || (st.doc?.project_id === id && storedMeta?.storageEpoch !== projectEpoch(st, id)))) || (!raw && !trashed)) {
                  throw new Error('Dự án đã thay đổi hoặc bị xóa ở tab khác.')
                }
                const items = trashList()
                if (raw !== null && !trashed) {
                  const doc = readStoredProject(raw, id)
                  if (!doc) throw new Error('Không đọc được dự án cần đưa vào thùng rác.')
                  const retired = items.filter(item => item.restoreId === id && storedMeta && (item.restoreEpoch
                    ? item.restorePrepared && item.restoreEpoch === storedMeta.storageEpoch
                    : JSON.stringify(trashCandidate(item, id)) === raw))
                  const previous = items.find(item => item.id === id)
                  if (previous && !retired.includes(previous) && previous.restoreId) {
                    throw new Error('Mục khôi phục cũ chưa xác minh được. Dữ liệu được giữ nguyên.')
                  }
                  trashed = pushTrash(doc, retired, storedMeta?.storageEpoch ?? null)
                }
                const saved = trashList().find(item => item.id === id)
                if (!trashed || !isSameTrashItem(saved, trashed)) {
                  throw new Error('Không xác thực được bản trong thùng rác.')
                }
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
              } catch (error) {
                const current = get()
                if (source.doc?.project_id === id && current.doc?.project_id === id
                  && current.generation === source.generation) {
                  let saveStatus: 'conflict' | 'error' | undefined
                  try {
                    const raw = projectRaw(id)
                    const storedMeta = loadRegistry().find(entry => entry.id === id)
                    if (raw === null || raw !== current.persistedRaw
                      || !storedMeta || storedMeta.storageEpoch !== projectEpoch(current, id)) saveStatus = 'conflict'
                  } catch { saveStatus = 'error' }
                  if (saveStatus) set({ saveStatus, saveError: String(error) })
                }
                throw error
              }
            })
          } catch (error) {
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
    try { await setRecentVisibility(id, true); return true }
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
  restoreTrash: async (expected) => {
    try {
      if (get().transitionBusy || get().leavePrompt) return false
      const restored = await withStorageWrite(() => {
        const items = trashList()
        let item = items.find(item => item.id === expected.id)
        if (!isSameTrashItem(item, expected)) throw new Error('Mục trong thùng rác đã thay đổi hoặc không còn tồn tại.')
        const registry = loadRegistry()
        const sourceId = item.id
        const restoreId = item.restoreId ?? (projectRaw(sourceId) !== null ? uuid() : sourceId)
        const candidate = trashCandidate(item, restoreId)
        const candidateRaw = JSON.stringify(candidate)
        if (!readStoredProject(candidateRaw, restoreId)) throw new Error('Tài liệu trong thùng rác không hợp lệ.')
        const current = projectRaw(restoreId)
        const meta = registry.find(entry => entry.id === restoreId)
        if (item.restoreId && !item.restoreEpoch) {
          if (!meta || current !== candidateRaw || !readStoredProject(current, restoreId)) {
            throw new Error('Không đủ thông tin để xác nhận lượt khôi phục cũ. Dữ liệu được giữ nguyên.')
          }
          removeVerifiedTrashItem(item)
          return candidate
        }
        if (item.restoreEpoch && meta?.storageEpoch === item.restoreEpoch) {
          const live = item.restorePrepared && readStoredProject(current, restoreId)
          if (!live) throw new Error('Dữ liệu khôi phục không khớp dự án hiện tại.')
          removeVerifiedTrashItem(item)
          return live
        }
        const orphan = meta && restoreId === sourceId && current === null && !item.restorePrepared
          && matchesTrashSource(item, meta) ? meta : undefined
        if (meta && !orphan) throw new Error('Metadata hiện tại không khớp dự án trong thùng rác.')
        if (!item.restoreId) {
          if (current !== null) throw new Error('ID khôi phục không còn trống.')
          item = updateVerifiedTrashItem(item, {
            ...item, restoreId, restoreEpoch: uuid(),
            sourceStorageEpoch: orphan ? orphan.storageEpoch ?? null : item.sourceStorageEpoch,
          })
        }
        const { restoreEpoch } = item
        if (!restoreEpoch) throw new Error('Thiếu định danh lượt khôi phục.')
        // Reserve before removing the old row so even an interrupted restore cannot revive its old epoch.
        if (orphan) {
          removeMeta(restoreId)
          if (loadRegistry().some(entry => entry.id === restoreId)) throw new Error('Không xác thực được việc dọn metadata cũ.')
        }
        if ((current !== null && current !== candidateRaw) || (item.restorePrepared && current === null)) {
          throw new Error('Bản khôi phục đã thay đổi hoặc đã bị xóa. Dữ liệu được giữ nguyên.')
        }
        if (current === null) {
          const result = saveProjectAtomic(candidate)
          if (!result.ok) throw new Error(result.error)
        }
        if (projectRaw(restoreId) !== candidateRaw) throw new Error('Không xác thực được tài liệu khôi phục.')
        if (!item.restorePrepared) item = updateVerifiedTrashItem(item, { ...item, restorePrepared: true })
        if (restoreId === sourceId && typeof item.sourceStorageEpoch === 'string') {
          const session = loadSession(restoreId)
          if (session?.storageEpoch === item.sourceStorageEpoch) saveSession(restoreId, { ...session, storageEpoch: restoreEpoch })
        }
        const restoredMeta = { ...metaFromDoc(candidate), storageEpoch: restoreEpoch }
        upsertMeta(restoredMeta)
        if (JSON.stringify(loadRegistry().find(entry => entry.id === restoreId)) !== JSON.stringify(restoredMeta)) {
          throw new Error('Không xác thực được metadata của bản khôi phục.')
        }
        removeVerifiedTrashItem(item)
        return candidate
      })
      set({ registry: loadRegistry() })
      get().toast('success', 'Đã khôi phục dự án', restored.name)
      return true
    } catch (e) { reportError('Khôi phục thất bại', e); return false }
  },
  purgeTrash: async (expected) => {
    const id = expected.id
    try {
      await withStorageWrite(() => {
        const item = trashList().find(item => item.id === id)
        if (!isSameTrashItem(item, expected)) throw new Error('Mục trong thùng rác đã thay đổi hoặc không còn tồn tại.')
        if (projectRaw(id) !== null || (item.restoreId && projectRaw(item.restoreId) !== null)) {
          throw new Error('Dự án hoặc bản khôi phục vẫn tồn tại. Hãy thử Khôi phục để hoàn tất.')
        }
        const linkedKeys = [STORAGE_KEYS.backup(id), STORAGE_KEYS.journal(id), STORAGE_KEYS.session(id)]
        for (const key of linkedKeys) {
          localStorage.removeItem(key)
          if (localStorage.getItem(key) !== null) throw new Error('Không xác thực được việc dọn dữ liệu dự án.')
        }
        if (loadRegistry().some(meta => meta.id === id)) {
          removeMeta(id)
          if (loadRegistry().some(meta => meta.id === id)) throw new Error('Không dọn được mục trong danh sách dự án.')
        }
        const settings = loadSettings()
        if (settings.lastProjectId === id || Object.hasOwn(settings.sessionByProject ?? {}, id)) {
          const sessionByProject = { ...settings.sessionByProject }
          delete sessionByProject[id]
          saveSettings({ ...settings, sessionByProject, lastProjectId: settings.lastProjectId === id ? null : settings.lastProjectId })
          const verified = loadSettings()
          if (verified.lastProjectId === id || Object.hasOwn(verified.sessionByProject ?? {}, id)) {
            throw new Error('Không dọn được tham chiếu dự án trong cài đặt.')
          }
        }
        removeVerifiedTrashItem(item)
      })
      ownedCommittedJournals.delete(id)
      const candidates = get().recovery.candidates.filter(candidate => candidate.projectId !== id)
      set({ registry: loadRegistry(), settings: loadSettings(), recovery: { candidates, open: get().recovery.open && candidates.length > 0 } })
      return true
    } catch (e) { reportError('Xóa thất bại', e); return false }
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
      const editor = st.editor
      const id = st.doc.project_id
      void writeProjectAuxiliary(st, () => {
        const journal = readDraftJournal(id)
        if (journal?.editor_session_id === editor.sessionId) clearDraftJournal(id)
      })
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
    if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
    set({ saveStatus: 'saving', _autosaveTimer: null })
    const promise = (async (): Promise<SaveResult> => {
      let journalRaw: string | null = null
      const r = await persistProject(snapshot, st.persistedRaw, {
        backupCount: st.settings.backupCount,
        beforeSave: () => { journalRaw = localStorage.getItem(STORAGE_KEYS.journal(snapshot.project_id)) },
        identity: { storageEpoch: projectEpoch(st, snapshot.project_id) },
        afterSave: () => {
          if (!journalRaw || localStorage.getItem(STORAGE_KEYS.journal(snapshot.project_id)) !== journalRaw
            || get().editor?.draft !== get().editor?.baseText) return
          const journal = readDraftJournal(snapshot.project_id)
          if (!journal) return
          const node = snapshot.topics.find(t => t.id === journal.node_id)
          const savedDraft = node && (journal.field === 'title' ? node.text : node.notes ?? '') === journal.draft_text
          const ownedDraft = ownsCommittedDraft(st, journalRaw) && snapshot.document_revision > journal.base_document_revision
          if (savedDraft || ownedDraft) {
            clearDraftJournal(snapshot.project_id)
            ownedCommittedJournals.delete(snapshot.project_id)
          }
        },
      })
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
    const ok = await openStored(get().doc!.project_id, false)
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
    set({ camera: c, cameraReady: true })
    const st = get()
    if (st.doc) {
      const camera = { ...c }
      if (_camSaveTimer) clearTimeout(_camSaveTimer)
      _flushCamera = () => writeCamera(st, camera)
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
    set({ editor: { sessionId: uuid(), nodeId, field, draft: baseText, baseText } })
  },
  updateDraft: (text) => {
    const st = get()
    if (!st.editor || st.transitionBusy || st.leavePrompt) return
    set({ editor: { ...st.editor, draft: text } })
    scheduleEditorDraft(get())
  },
  commitEdit: () => {
    const st = get()
    if (!st.editor) return true
    if (!st.doc) return false
    const { sessionId, nodeId, field, draft, baseText } = st.editor
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
    if (final !== baseText) {
      const ok = field === 'title' ? get().dispatch({ type: 'setText', id: nodeId, before: baseText, after: final }, 'Sửa tiêu đề')
      : get().dispatch({ type: 'setProps', id: nodeId, before: { notes: baseText || null }, after: { notes: final || null } }, 'Sửa ghi chú')
      if (st.settings.draftJournalEnabled) {
        enqueueDraft(st, { journal_schema_version: 1, editor_session_id: sessionId, project_id: st.doc.project_id, node_id: nodeId, field, base_document_revision: st.doc.document_revision, base_field_value: baseText, draft_text: final, timestamp: new Date().toISOString() }, ok)
      }
      if (!ok) { set({ _journalTimer: null }); return false }
    }
    set({ editor: null, _journalTimer: null })
    return true
  },
  cancelEdit: () => {
    const st = get()
    if (st._journalTimer) clearTimeout(st._journalTimer)
    if (st.doc && st.editor) {
      const { project_id: id } = st.doc
      const editor = st.editor
      void writeProjectAuxiliary(st, () => {
        const j = readDraftJournal(id)
        if (j?.editor_session_id === editor.sessionId) clearDraftJournal(id)
      })
    }
    set({ editor: null, _journalTimer: null })
  },

  /* ---------------- dialogs ---------------- */
  setImportOpen: (v) => set({ importOpen: v }),
  openExport: (scopeRootId) => set({ exportOpen: { open: true, optionsRevision: null, scopeRootId: scopeRootId ?? null } }),
  closeExport: () => set({ exportOpen: null }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),
  dismissRecovery: async (i) => {
    const st = get()
    if (st.transitionBusy || st.leavePrompt) return
    const c = st.recovery.candidates[i]
    if (!c) return
    try {
      if (c.draft) await withStorageWrite(() => {
        assertProjectNotRestoring(c.projectId)
        if (JSON.stringify(readDraftJournal(c.projectId)) === JSON.stringify(c.draft)) clearDraftJournal(c.projectId)
      })
      const candidates = get().recovery.candidates.filter(candidate => candidate !== c)
      set({ recovery: { open: candidates.length > 0, candidates } })
    } catch (error) { reportError('Không thể bỏ qua dữ liệu khôi phục', error) }
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
    const verifySource = () => {
      assertProjectNotRestoring(c.projectId)
      if (c.draft && JSON.stringify(readDraftJournal(c.projectId)) !== JSON.stringify(c.draft)
        || c.kind === 'backup' && localStorage.getItem(STORAGE_KEYS.backup(c.projectId)) === null) {
        throw new Error('Nguồn khôi phục đã thay đổi hoặc bị xóa.')
      }
    }
    if (!await writeCandidate(key, doc, true, true, copy ? null : c.baseRaw!, verifySource)) return false
    await withStorageWrite(() => {
      const j = readDraftJournal(c.projectId)
      const meta = loadRegistry().find(item => item.id === c.projectId)
      if (c.draft && !isTrashRestorePending(c.projectId, meta?.storageEpoch)
        && JSON.stringify(j) === JSON.stringify(c.draft)) clearDraftJournal(c.projectId)
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
const ownedCommittedJournals = new Map<string, { raw: string; generation: number; epoch?: string }>()
const draftWrites = new Map<string, Promise<boolean>>()
type PendingDraftWrite = { id: string; generation: number; epoch?: string; preserveForeign: boolean }
const pendingDraftWrites = new Set<PendingDraftWrite>()
let activeProjectIdentity: { id: string; generation: number; epoch?: string; initialEpochRaw?: string } | undefined

export function captureProjectRenameTarget({ id, storageEpoch }: Pick<ProjectMeta, 'id' | 'storageEpoch'>): ProjectRenameTarget {
  const target: ProjectRenameTarget = { id, storageEpoch }
  if (storageEpoch !== undefined) return target
  try {
    const meta = loadRegistry().find(entry => entry.id === id)
    const raw = projectRaw(id)
    if (meta && meta.storageEpoch === undefined && raw !== null) {
      target.legacy = { raw, generation: useApp.getState().generation }
    }
  } catch { /* The regular epoch and source checks still apply at confirmation. */ }
  return target
}

async function setRecentVisibility(id: string, hidden: boolean, active?: { generation: number; epoch?: string }) {
  await withStorageWrite(() => {
    const registry = loadRegistry()
    const entry = registry.find(meta => meta.id === id)
    if (isTrashRestorePending(id, entry?.storageEpoch)) throw new Error(pendingTrashRestoreMessage)
    if (!entry || projectRaw(id) === null) throw new Error('Dự án không còn tồn tại.')
    if (active) {
      const state = useApp.getState()
      if (state.transitionBusy || state.leavePrompt || state.generation !== active.generation || entry.storageEpoch !== active.epoch) {
        throw new Error('Dự án đang mở đã thay đổi.')
      }
      if (!entry.recentHidden) return
    }
    const { recentHidden, ...visible } = entry
    const updated = hidden ? { ...visible, recentHidden: true } : { ...visible, lastOpened: new Date().toISOString() }
    saveRegistry(hidden ? registry.map(meta => meta.id === id ? updated : meta) : [updated, ...registry.filter(meta => meta.id !== id)])
    if (JSON.stringify(loadRegistry().find(meta => meta.id === id)) !== JSON.stringify(updated)) {
      throw new Error('Không xác thực được thay đổi danh sách gần đây.')
    }
  })
  useApp.setState({ registry: loadRegistry() })
}

const pendingTrashRestoreMessage = 'Dự án đang khôi phục. Hãy hoàn tất trong Thùng rác.'

function matchesTrashSource(item: TrashItem, meta: ProjectMeta) {
  const doc = item.doc
  return (item.sourceStorageEpoch === undefined || item.sourceStorageEpoch === (meta.storageEpoch ?? null))
    && meta.id === doc.project_id && meta.name === doc.name && meta.createdAt === doc.created_at
    && meta.updatedAt === doc.updated_at && meta.revision === doc.document_revision && meta.nodeCount === doc.topics.length
}

function assertProjectNotRestoring(id: string) {
  const meta = loadRegistry().find(item => item.id === id)
  if (isTrashRestorePending(id, meta?.storageEpoch)) throw new Error(pendingTrashRestoreMessage)
}

function trashCandidate(item: TrashItem, restoreId: string) {
  const doc = { ...structuredClone(item.doc), project_id: restoreId }
  if (restoreId !== item.id) doc.name += ' (khôi phục)'
  return doc
}

function updateVerifiedTrashItem(item: TrashItem, update: TrashItem): TrashItem {
  saveTrashList(trashList().map(other => isSameTrashItem(other, item) ? update : other))
  const saved = trashList().find(other => isSameTrashItem(other, item))
  if (JSON.stringify(saved) !== JSON.stringify(update)) throw new Error('Không xác thực được phiên khôi phục.')
  return update
}

function removeVerifiedTrashItem(item: TrashItem) {
  const current = trashList().find(other => other.id === item.id)
  if (!isSameTrashItem(current, item)) throw new Error('Mục trong thùng rác đã thay đổi.')
  removeFromTrash(item.id)
  if (trashList().some(other => other.id === item.id)) throw new Error('Không xác thực được việc cập nhật thùng rác.')
}

function projectEpoch(st: AppState, id: string): string | undefined {
  if (activeProjectIdentity?.id === id && activeProjectIdentity.generation === st.generation) {
    return activeProjectIdentity.epoch
  }
  return st.registry.find(meta => meta.id === id)?.storageEpoch
}

async function writeProjectAuxiliary(st: AppState, write: () => void): Promise<boolean> {
  const doc = st.doc
  if (!doc) return false
  const id = doc.project_id
  const epoch = projectEpoch(st, id)
  try {
    return await withStorageWrite(() => {
      const raw = projectRaw(id)
      const meta = loadRegistry().find(item => item.id === id)
      if (raw === null || meta?.storageEpoch !== epoch || isTrashRestorePending(id, meta?.storageEpoch)) return false
      if (!epoch && raw !== st.persistedRaw && readStoredProject(raw, id)?.created_at !== doc.created_at) return false
      write()
      return true
    })
  } catch { return false }
}

function writeCamera(st: AppState, camera: AppState['camera']) {
  if (!st.doc) return Promise.resolve(false)
  const id = st.doc.project_id
  const storageEpoch = projectEpoch(st, id)
  return writeProjectAuxiliary(st, () => saveSession(id, { camera, storageEpoch }))
}

function ownsCommittedDraft(st: AppState, raw: string) {
  const id = st.doc?.project_id
  if (!id) return false
  const committed = ownedCommittedJournals.get(id)
  return committed?.raw === raw && committed.generation === st.generation && committed.epoch === projectEpoch(st, id)
}

function scheduleEditorDraft(st: AppState, preserveForeign = false) {
  const { doc, editor } = st
  if (!st.settings.draftJournalEnabled || !doc || !editor) return
  if (st._journalTimer) clearTimeout(st._journalTimer)
  const timer = setTimeout(() => {
    const current = useApp.getState()
    if (current._journalTimer !== timer) return
    useApp.setState({ _journalTimer: null })
    if (current.generation !== st.generation || current.transitionBusy || current.editor !== editor) return
    enqueueDraft(st, {
      journal_schema_version: 1, editor_session_id: editor.sessionId, project_id: doc.project_id,
      node_id: editor.nodeId, field: editor.field, base_document_revision: doc.document_revision,
      base_field_value: editor.baseText, draft_text: editor.draft, timestamp: new Date().toISOString(),
    }, false, preserveForeign)
  }, 500)
  useApp.setState({ _journalTimer: timer })
}

function enqueueDraft(st: AppState, journal: DraftJournalRecord, committed = false, preserveForeign = false) {
  const id = journal.project_id
  const epoch = projectEpoch(st, id)
  const entry: PendingDraftWrite = { id, generation: st.generation, epoch, preserveForeign }
  if (nativeCloseAttempt && closeMatchesDraft(nativeCloseAttempt, entry)) entry.preserveForeign = true
  pendingDraftWrites.add(entry)
  const write = writeProjectAuxiliary(st, () => {
    if (entry.preserveForeign) {
      const current = localStorage.getItem(STORAGE_KEYS.journal(id))
      if (current !== null && !closeOwnsDraft(st, current)) {
        const attempt = nativeCloseAttempt
        if (attempt && closeMatchesDraft(attempt, entry)
          && journal.editor_session_id === attempt.state.editor?.sessionId) attempt.resumeDraftTimer = true
        return
      }
    }
    writeDraftJournal(journal)
    if (committed) {
      const raw = JSON.stringify(journal)
      if (localStorage.getItem(STORAGE_KEYS.journal(id)) === raw) {
        ownedCommittedJournals.set(id, { raw, generation: st.generation, epoch })
      }
    }
  })
  draftWrites.set(id, write)
  void write.then(() => {
    pendingDraftWrites.delete(entry)
    if (draftWrites.get(id) === write) draftWrites.delete(id)
  })
}
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
  const flush = _flushCamera
  _flushCamera = undefined
  return flush?.()
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
  activeProjectIdentity = undefined
  useApp.setState(st => ({ doc: null, editor: null, exportOpen: null, generation: st.generation + 1, persistedRaw: null, savedHash: null, saveStatus: 'none', saveError: null, past: [], future: [], selection: [], focusRootId: null, _autosaveTimer: null, _journalTimer: null, _unwatch: null }))
}
function activate(doc: ProjectDocV3, raw: string) {
  assertUniqueTopicIds(doc.topics)
  const previous = useApp.getState()
  const registry = loadRegistry()
  const epoch = registry.find(meta => meta.id === doc.project_id)?.storageEpoch
  const sameId = previous.doc?.project_id === doc.project_id
  const previousEpoch = sameId ? projectEpoch(previous, doc.project_id) : undefined
  const sameProject = sameId && previousEpoch === epoch && (epoch !== undefined || previous.persistedRaw === raw)
  stopProjectTimers()
  const session = loadSession(doc.project_id)
  const storedCamera = session && (session.storageEpoch === undefined
    ? !sameId || sameProject
    : session.storageEpoch === epoch) ? session.camera : undefined
  const camera = [sameProject && previous.cameraReady ? previous.camera : undefined, storedCamera]
    .find(value => value && [value.x, value.y, value.zoom].every(Number.isFinite) && value.zoom >= 0.1 && value.zoom <= 4)
  activeProjectIdentity = { id: doc.project_id, generation: previous.generation + 1, epoch }
  useApp.setState(st => ({ doc: structuredClone(doc), generation: st.generation + 1, persistedRaw: raw, savedHash: simpleHash(raw), saveStatus: 'clean', saveError: null, settings: loadSettings(), registry, editor: null, exportOpen: null, past: [], future: [], selection: [], focusRootId: null, camera: camera ?? { x: 0, y: 0, zoom: 1 }, cameraReady: !!camera, search: { ...st.search, open: false, matches: [] }, _autosaveTimer: null, _journalTimer: null }))
  useApp.getState()._startWatch()
}
async function openStored(id: string, opened: boolean): Promise<boolean> {
  const open = (canWrite: boolean) => {
    assertProjectNotRestoring(id)
    const raw = projectRaw(id)
    if (!raw) throw new Error('Dự án không tồn tại hoặc đã bị xóa')
    const doc = readStoredProject(raw, id)
    if (!doc) throw new Error('Dữ liệu dự án không hợp lệ')
    const before = canWrite ? loadRegistry().find(meta => meta.id === id) : undefined
    if (canWrite) writeAndVerifyMetadata(doc, true, () => {}, opened)
    const generation = useApp.getState().generation + 1
    activate(doc, raw)
    const identity = activeProjectIdentity
    const st = useApp.getState()
    if (before && before.storageEpoch === undefined && identity?.id === id && identity.epoch !== undefined
      && identity.generation === generation && st.generation === generation && st.persistedRaw === raw) {
      identity.initialEpochRaw = raw
    }
    return true
  }
  if (typeof navigator === 'undefined' || !navigator.locks) {
    const openedReadOnly = open(false)
    useApp.setState({ saveStatus: 'error', saveError: 'Môi trường không hỗ trợ khóa ghi. Nội dung đang ở RAM và có thể Xuất.' })
    reportError('Không thể ghi an toàn', 'Hãy dùng localhost/HTTPS và trình duyệt hỗ trợ Web Locks. Bạn vẫn có thể Xuất nội dung.')
    return openedReadOnly
  }
  return withStorageWrite(() => open(true))
}
async function writeCandidate(key: string, doc: ProjectDocV3, makeActive: boolean, keep = false, expected: string | null = null, beforeSave?: () => void): Promise<boolean> {
  assertUniqueTopicIds(doc.topics)
  let candidate = pendingCandidates.get(key)
  if (!candidate) {
    candidate = { doc: structuredClone(doc), raw: expected }
    pendingCandidates.set(key, candidate)
  }
  candidate.doc = { ...structuredClone(doc), project_id: candidate.doc.project_id, name: candidate.doc.name }
  const r = await persistProject(candidate.doc, candidate.raw, { activate: makeActive, beforeSave })
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
    const pendingDraft = source.doc ? draftWrites.get(source.doc.project_id) : undefined
    if (save) {
      if (!source.commitEdit()) return false
    }
    useApp.setState({ transitionBusy: true })
    if (!save && source.doc) {
      if (pendingDraft) await pendingDraft
      journal = localStorage.getItem(STORAGE_KEYS.journal(source.doc.project_id))
    }
    if (save) {
      const result = await useApp.getState().saveNow()
      if (result.kind !== 'saved' || result.stillDirty) return false
    } else if (activeSave?.generation === source.generation) await activeSave.promise
    const ok = await run()
    if (ok && source.doc && useApp.getState().generation !== source.generation && journal) {
      const { project_id: id } = source.doc
      await writeProjectAuxiliary(source, () => {
        if (localStorage.getItem(STORAGE_KEYS.journal(id)) === journal) clearDraftJournal(id)
      })
    }
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

export function inspectNativeCloseState(requestId: string): NativeCloseDecision {
  nativeCloseAttempt = undefined
  const st = useApp.getState()
  if (st.transitionBusy || st.leavePrompt) {
    return { decision: 'busy', message: 'Đang có thao tác lưu hoặc chuyển dự án khác.' }
  }
  if (st.doc) {
    const meta = loadRegistry().find(entry => entry.id === st.doc!.project_id)
    if (st.saveStatus === 'conflict' || projectRaw(st.doc.project_id) !== st.persistedRaw
      || !meta || meta.storageEpoch !== projectEpoch(st, st.doc.project_id)) {
      if (st.saveStatus !== 'conflict') {
        st.toast('warn', 'Xung đột tệp', 'Dự án đã thay đổi hoặc bị xóa ở phiên khác. Chọn Tải lại hoặc Lưu thành.')
        useApp.setState({ saveStatus: 'conflict' })
      }
      return { decision: 'conflict', message: 'Dự án đang có xung đột tệp. Hãy chọn Tải lại hoặc Lưu thành trước khi đóng.' }
    }
  }
  nativeCloseAttempt = {
    id: requestId,
    state: st,
    epoch: st.doc ? projectEpoch(st, st.doc.project_id) : undefined,
    journalRaw: st.doc ? localStorage.getItem(STORAGE_KEYS.journal(st.doc.project_id)) : null,
    deadline: Infinity,
  }
  for (const entry of pendingDraftWrites) {
    if (closeMatchesDraft(nativeCloseAttempt, entry)) entry.preserveForeign = true
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

type NativeCloseResult = { ok: true; sessionWarning?: string } | { ok: false; kind?: string; error: string }

type NativeCloseAttempt = {
  id: string
  state: AppState
  epoch?: string
  journalRaw: string | null
  deadline: number
  resumeDraftTimer?: true
}
let nativeCloseAttempt: NativeCloseAttempt | undefined
const staleNativeClose = 'Dự án hoặc bản nháp đã thay đổi trong khi đóng. Hãy kiểm tra và thử lại.'

function closeMatchesDraft(attempt: NativeCloseAttempt, entry: Pick<PendingDraftWrite, 'id' | 'generation' | 'epoch'>) {
  return attempt.state.doc?.project_id === entry.id
    && attempt.state.generation === entry.generation && attempt.epoch === entry.epoch
}

function matchingCloseState(attempt: NativeCloseAttempt, expected: AppState) {
  const current = useApp.getState()
  if (nativeCloseAttempt !== attempt || performance.now() >= attempt.deadline || current.transitionBusy || current.leavePrompt
    || current.generation !== expected.generation || current.doc !== expected.doc || current.editor !== expected.editor
    || current.persistedRaw !== expected.persistedRaw) throw new Error(staleNativeClose)
  if (current.doc) {
    const { project_id: id } = current.doc
    const meta = loadRegistry().find(entry => entry.id === id)
    if (!meta || meta.storageEpoch !== attempt.epoch || !current.persistedRaw
      || projectRaw(id) !== current.persistedRaw || current.saveStatus === 'conflict') {
      throw new Error(staleNativeClose)
    }
  }
  return current
}

function beginNativeClose(id: string) {
  const attempt = nativeCloseAttempt
  if (!attempt || attempt.id !== id || attempt.deadline !== Infinity) throw new Error(staleNativeClose)
  // Complete before the native bridge's timeout, even if a previous write is slow.
  attempt.deadline = performance.now() + 5500
  matchingCloseState(attempt, attempt.state)
  return attempt
}

function closeOwnsDraft(state: AppState, raw: string) {
  const id = state.doc?.project_id
  if (!id) return false
  if (ownsCommittedDraft(state, raw)) return true
  const editor = state.editor
  if (!editor) return false
  try {
    const journal = JSON.parse(raw) as DraftJournalRecord | null
    return journal?.journal_schema_version === 1 && journal.project_id === id && journal.editor_session_id === editor.sessionId
      && journal.node_id === editor.nodeId && journal.field === editor.field
  } catch { return false }
}

async function finishNativeClose(
  attempt: NativeCloseAttempt,
  expected: AppState,
  journalRaw: string | null,
  discard = false,
): Promise<NativeCloseResult> {
  await flushCameraSession()
  return withStorageWrite(() => {
    const id = expected.doc?.project_id
    const journalKey = id ? STORAGE_KEYS.journal(id) : null
    function verify() {
      const current = matchingCloseState(attempt, expected)
      if (activeSave?.generation === current.generation || (!discard && hasUnsaved(current))
        || (!discard && journalKey && localStorage.getItem(journalKey) !== journalRaw)
        || (id && draftWrites.has(id))) throw new Error(staleNativeClose)
      return current
    }
    const current = verify()
    let sessionWarning: string | undefined
    if (id) {
      try { saveSession(id, { camera: current.camera, storageEpoch: attempt.epoch }) }
      catch { sessionWarning = 'Không lưu được vị trí canvas trước khi đóng.' }
    }
    verify()
    if (discard && id && journalKey) {
      const diskDoc = readStoredProject(expected.persistedRaw, id)
      if (!diskDoc) throw new Error('Không đọc được bản lưu để bỏ thay đổi.')
      const currentDraft = localStorage.getItem(journalKey)
      const discardJournal = currentDraft !== null && closeOwnsDraft(expected, currentDraft)
      if (!discardJournal && currentDraft !== journalRaw) throw new Error(staleNativeClose)
      if (discardJournal) {
        if (localStorage.getItem(journalKey) !== currentDraft) throw new Error(staleNativeClose)
        clearDraftJournal(id)
        if (localStorage.getItem(journalKey) !== null) throw new Error('Không xác thực được việc dọn bản nháp.')
        ownedCommittedJournals.delete(id)
      }
      const state = matchingCloseState(attempt, expected)
      if (state._journalTimer) clearTimeout(state._journalTimer)
      if (state._autosaveTimer) clearTimeout(state._autosaveTimer)
      useApp.setState({ doc: diskDoc, editor: null, saveStatus: 'clean', saveError: null, _autosaveTimer: null, _journalTimer: null })
    }
    try { markCleanShutdown() } catch { /* recovery remains available */ }
    nativeCloseAttempt = undefined
    return { ok: true, sessionWarning }
  })
}

export async function finalizeNativeCleanClose(requestId: string): Promise<NativeCloseResult> {
  try {
    const attempt = beginNativeClose(requestId)
    if (hasUnsaved(attempt.state)) throw new Error(staleNativeClose)
    return await finishNativeClose(attempt, attempt.state, attempt.journalRaw)
  } catch (error) { return nativeCloseFailure(requestId, error) }
}

export async function commitAndFlushNativeClose(requestId: string): Promise<NativeCloseResult> {
  try {
    const attempt = beginNativeClose(requestId)
    const st = attempt.state
    const ownedDraft = attempt.journalRaw !== null && closeOwnsDraft(st, attempt.journalRaw)
    if (st.editor && !st.commitEdit()) throw new Error('Không thể áp dụng nội dung đang soạn trước khi lưu.')
    const expected = useApp.getState()
    if (hasUnsaved(expected) || activeSave?.generation === expected.generation) {
      const result = await expected.saveNow()
      if (result.kind !== 'saved' || result.stillDirty) {
        throw new Error(result.kind === 'error' || result.kind === 'conflict' ? result.message : 'Không thể lưu dự án an toàn.')
      }
    }
    const after = useApp.getState()
    if (after.doc !== expected.doc || after.editor !== expected.editor || after.generation !== expected.generation) {
      throw new Error(staleNativeClose)
    }
    const raw = after.doc ? localStorage.getItem(STORAGE_KEYS.journal(after.doc.project_id)) : null
    if (raw !== null && (raw !== attempt.journalRaw || ownedDraft)) {
      throw new Error('Chưa xác minh được việc lưu và dọn bản nháp.')
    }
    return await finishNativeClose(attempt, after, raw)
  } catch (error) { return nativeCloseFailure(requestId, error) }
}

export async function discardAndPrepareNativeClose(requestId: string): Promise<NativeCloseResult> {
  try {
    const attempt = beginNativeClose(requestId)
    const st = attempt.state
    const id = st.doc?.project_id
    if (!id) return await finishNativeClose(attempt, st, null)
    if (st._journalTimer) {
      clearTimeout(st._journalTimer)
      attempt.resumeDraftTimer = true
    }
    if (st._autosaveTimer) clearTimeout(st._autosaveTimer)
    useApp.setState({ _autosaveTimer: null, _journalTimer: null })
    if (activeSave?.generation === st.generation) await activeSave.promise
    await draftWrites.get(id)
    return await finishNativeClose(attempt, st, attempt.journalRaw, true)
  } catch (error) { return nativeCloseFailure(requestId, error) }
}

function nativeCloseFailure(requestId: string, error: unknown): NativeCloseResult {
  cancelNativeClose(requestId)
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export function cancelNativeClose(requestId: string): { ok: true } {
  const attempt = nativeCloseAttempt
  if (attempt?.id === requestId) {
    nativeCloseAttempt = undefined
    const st = useApp.getState()
    if (st.saveStatus === 'dirty' && !st.leavePrompt) st.scheduleAutosave()
    const id = st.doc?.project_id
    if ((attempt.resumeDraftTimer || st._journalTimer) && id && st.editor
      && st.editor.sessionId === attempt.state.editor?.sessionId
      && closeMatchesDraft(attempt, { id, generation: st.generation, epoch: projectEpoch(st, id) })) {
      if (st.settings.draftJournalEnabled) {
        scheduleEditorDraft(st, true)
      } else if (st._journalTimer) {
        clearTimeout(st._journalTimer)
        useApp.setState({ _journalTimer: null })
      }
    }
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
