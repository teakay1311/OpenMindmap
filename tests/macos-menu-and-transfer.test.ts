import { describe, expect, it, beforeEach } from 'bun:test'
import { newProjectDoc, type ProjectDocV3 } from '../lib/core/types'
import { defaultSettings, metaFromDoc, STORAGE_KEYS } from '../lib/storage/projects'
import { withStorageWrite } from '../lib/storage/persistence'
import {
  buildMenuStateSnapshot,
  copySelection,
  pasteFromClipboard,
} from '../lib/core/menuCatalog'
import { mountNativeBridge } from '../lib/native/bridge'
import {
  useApp,
  inspectNativeCloseState,
  finalizeNativeCleanClose,
  commitAndFlushNativeClose,
  discardAndPrepareNativeClose,
  cancelNativeClose,
} from '../lib/store'
import {
  EXPECTED_LOCAL_ORIGIN,
  exportWorkspaceReadonly,
  validateTransferPackage,
  importWorkspaceTransactional,
  type StorageLike,
  type TransferJournalHooks,
  type TransferJournalState,
} from '../lib/transfer/workspaceTransfer'

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & { dump: () => Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    get length() { return map.size },
    key(index: number) { return Array.from(map.keys())[index] ?? null },
    getItem(key: string) { return map.has(key) ? map.get(key)! : null },
    setItem(key: string, value: string) { map.set(key, String(value)) },
    removeItem(key: string) { map.delete(key) },
    dump() { return Object.fromEntries(map.entries()) },
  }
}

function setupBrowserGlobals(storage: StorageLike) {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const winObj: Record<string, unknown> = {
    location: { origin: EXPECTED_LOCAL_ORIGIN },
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent() { return true },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} } },
    __OMM_NATIVE_MACOS__: { platform: 'macos', appVersion: '0.2.1' },
    webkit: { messageHandlers: { ommMenuState: { postMessage() {} } } },
  }
  const bodyEl = {
    style: {},
    classList: { toggle() {} },
    appendChild() {},
  }
  const docObj = {
    documentElement: bodyEl,
    body: bodyEl,
    activeElement: null,
    visibilityState: 'visible',
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
    createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {} }),
  }
  Object.defineProperty(globalThis, 'window', { value: winObj, writable: true, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: docObj, writable: true, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true })
  ;(globalThis as unknown as { MutationObserver: unknown }).MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { navigator: unknown }).navigator = {
    userAgent: 'BunTest',
    locks: {
      request: async (_name: string, _opts: unknown, cb?: () => unknown) => {
        const fn = typeof _opts === 'function' ? _opts : cb
        return await fn!()
      },
    },
  }
}

describe('macOS Menu Catalog & Bridge Guards', () => {
  let storage: ReturnType<typeof createMemoryStorage>

  beforeEach(() => {
    storage = createMemoryStorage()
    setupBrowserGlobals(storage)
    useApp.setState({
      hydrated: true,
      doc: null,
      generation: 1,
      persistedRaw: null,
      savedHash: null,
      saveStatus: 'none',
      saveError: null,
      past: [],
      future: [],
      selection: [],
      editor: null,
      transitionBusy: false,
      leavePrompt: null,
      registry: [],
    })
  })

  it('builds A01-A43 predicates, caps recent projects to 8, and deduplicates requestId', async () => {
    const doc = newProjectDoc('Dự án Tiếng Việt 🌳')
    doc.topics.push({
      id: 'c1', role: 'branch', parent_id: doc.central_topic_id, order: 0, text: 'Nhánh 1',
      collapsed: false, branch_side: 'auto', branch_color_seed: null, style: {}, branch_style_override: null,
      image: null, icon: null, checkbox: null, url: null, date: null, numbering: null, manual_position: null, notes: null,
    })
    const reg = Array.from({ length: 12 }, (_, i) => ({
      id: `p-${i}`,
      name: `Dự án ${i}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
      lastOpened: new Date().toISOString(),
      nodeCount: 2,
    }))
    useApp.setState({
      doc,
      generation: 5,
      persistedRaw: JSON.stringify(doc),
      saveStatus: 'clean',
      registry: reg,
      selection: [doc.central_topic_id],
    })

    const snapCentral = buildMenuStateSnapshot('vs-1', useApp.getState())
    expect(snapCentral.recentProjects.length).toBe(8)
    expect(snapCentral.commands.A18.label).toBe('Thêm nhánh chính')
    expect(snapCentral.commands.A13.enabled).toBe(false)
    expect(snapCentral.commands.EDIT_CUT.enabled).toBe(false)
    expect(snapCentral.commands.A12.enabled).toBe(true)

    useApp.setState({ selection: ['c1'] })
    const snapChild = buildMenuStateSnapshot('vs-1', useApp.getState())
    expect(snapChild.commands.A18.label).toBe('Chủ đề ngang hàng')
    expect(snapChild.commands.A13.enabled).toBe(true)
    expect(snapChild.commands.EDIT_CUT.enabled).toBe(true)

    const unmount = mountNativeBridge()
    try {
      const bridge = (window as unknown as { __ommBridge: NonNullable<Window['__ommBridge']> }).__ommBridge
      const stale = bridge.executeCommand({ commandId: 'A30', requestId: 'r-stale', expectedProjectGeneration: 4 })
      expect(stale.ok).toBe(false)
      expect(stale.reason).toBe('stale_generation')

      const ok1 = bridge.executeCommand({ commandId: 'A30', requestId: 'r-1', expectedProjectGeneration: 5 })
      expect(ok1.ok).toBe(true)
      expect(ok1.handled).toBe(true)
      expect(useApp.getState().doc?.topics.find((t) => t.id === 'c1')?.checkbox).toBe(true)

      const dup = bridge.executeCommand({ commandId: 'A30', requestId: 'r-1', expectedProjectGeneration: 5 })
      expect(dup.deduplicated).toBe(true)
      expect(useApp.getState().doc?.topics.find((t) => t.id === 'c1')?.checkbox).toBe(true)

      // Copy + Paste branch
      copySelection(false)
      expect(buildMenuStateSnapshot('vs-1', useApp.getState()).commands.EDIT_PASTE.enabled).toBe(true)
      pasteFromClipboard()
      expect(useApp.getState().doc?.topics.length).toBe(3)
    } finally {
      unmount()
    }
  })

  it('handles native close save/discard/conflict while preserving lastProjectId', async () => {
    const doc = newProjectDoc('Bản đồ Lưu An Toàn')
    const raw = JSON.stringify(doc)
    storage.setItem(STORAGE_KEYS.project(doc.project_id), raw)
    storage.setItem(STORAGE_KEYS.registry, JSON.stringify([{
      id: doc.project_id, name: doc.name, createdAt: doc.created_at, updatedAt: doc.updated_at,
      revision: doc.document_revision, lastOpened: doc.updated_at, nodeCount: doc.topics.length,
    }]))
    storage.setItem(STORAGE_KEYS.settings, JSON.stringify({ lastProjectId: doc.project_id }))

    useApp.setState({
      doc,
      generation: 2,
      persistedRaw: raw,
      saveStatus: 'clean',
      camera: { x: 120, y: -45, zoom: 1.25 },
      settings: { ...useApp.getState().settings, lastProjectId: doc.project_id },
    })

    // 1. Clean close preserves lastProjectId and marks cleanShutdown
    expect(inspectNativeCloseState('close-test').decision).toBe('allow-clean')
    await finalizeNativeCleanClose('close-test')
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBe('1')
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.settings)!).lastProjectId).toBe(doc.project_id)
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.session(doc.project_id))!).camera).toEqual({ x: 120, y: -45, zoom: 1.25 })

    // 2. Dirty inline editor prompts confirm-dirty -> Save commits + writes + clears journal + preserves lastProjectId
    storage.removeItem(STORAGE_KEYS.cleanShutdown)
    storage.setItem(STORAGE_KEYS.journal(doc.project_id), JSON.stringify({
      journal_schema_version: 1, project_id: doc.project_id, node_id: doc.central_topic_id, field: 'title',
      base_document_revision: 1, base_field_value: doc.name, draft_text: 'Tên Mới Đã Lưu', timestamp: new Date().toISOString(),
    }))
    useApp.setState({
      editor: { sessionId: 'close-test-editor', nodeId: doc.central_topic_id, field: 'title', baseText: doc.name, draft: 'Tên Mới Đã Lưu' },
      saveStatus: 'clean',
    })
    expect(inspectNativeCloseState('close-test').decision).toBe('confirm-dirty')
    const saveRes = await commitAndFlushNativeClose('close-test')
    expect(saveRes.ok).toBe(true)
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBe('1')
    expect(storage.getItem(STORAGE_KEYS.journal(doc.project_id))).toBeNull()
    const savedDoc = JSON.parse(storage.getItem(STORAGE_KEYS.project(doc.project_id))!) as ProjectDocV3
    expect(savedDoc.topics[0].text).toBe('Tên Mới Đã Lưu')
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.settings)!).lastProjectId).toBe(doc.project_id)

    // 3. Conflict blocks closing cleanly
    const curRaw = storage.getItem(STORAGE_KEYS.project(doc.project_id))!
    storage.setItem(STORAGE_KEYS.project(doc.project_id), curRaw.replace('Tên Mới Đã Lưu', 'Xung đột từ tab khác'))
    expect(inspectNativeCloseState('close-test').decision).toBe('conflict')

    // 4. Discard clears draft journal and keeps last saved raw + lastProjectId
    storage.setItem(STORAGE_KEYS.project(doc.project_id), curRaw)
    storage.setItem(STORAGE_KEYS.journal(doc.project_id), JSON.stringify({
      journal_schema_version: 1, project_id: doc.project_id, node_id: doc.central_topic_id, field: 'title',
      base_document_revision: savedDoc.document_revision, base_field_value: 'Tên Mới Đã Lưu',
      editor_session_id: 'close-test-editor', draft_text: 'Bỏ đi', timestamp: new Date().toISOString(),
    }))
    useApp.setState({
      persistedRaw: curRaw,
      saveStatus: 'dirty',
      editor: { sessionId: 'close-test-editor', nodeId: doc.central_topic_id, field: 'title', baseText: 'Tên Mới Đã Lưu', draft: 'Bỏ đi' },
    })
    expect(inspectNativeCloseState('close-test').decision).toBe('confirm-dirty')
    await discardAndPrepareNativeClose('close-test')
    expect(storage.getItem(STORAGE_KEYS.journal(doc.project_id))).toBeNull()
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBe('1')
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.settings)!).lastProjectId).toBe(doc.project_id)
    expect((JSON.parse(storage.getItem(STORAGE_KEYS.project(doc.project_id))!) as ProjectDocV3).topics[0].text).toBe('Tên Mới Đã Lưu')
    cancelNativeClose('close-test')
  })
  it('close tolerates only camera failure and rejects a changed document or editor while waiting', async () => {
    const doc = newProjectDoc('Native close')
    const raw = JSON.stringify(doc)
    const id = doc.project_id
    const projectKey = STORAGE_KEYS.project(id)
    const settingKey = STORAGE_KEYS.cleanShutdown
    storage.setItem(projectKey, raw)
    storage.setItem(STORAGE_KEYS.registry, JSON.stringify([{ id, storageEpoch: 'native-close-epoch' }]))
    useApp.setState({ doc, persistedRaw: raw, saveStatus: 'clean', registry: [{ id, storageEpoch: 'native-close-epoch' }] as ReturnType<typeof useApp.getState>['registry'] })
    const write = storage.setItem
    storage.setItem = (key, value) => {
      if (key === STORAGE_KEYS.session(id)) throw new Error('TEST_CAMERA_QUOTA')
      write(key, value)
    }
    expect(inspectNativeCloseState('camera-quota').decision).toBe('allow-clean')
    expect(await finalizeNativeCleanClose('camera-quota')).toMatchObject({ ok: true, sessionWarning: expect.any(String) })
    expect(storage.getItem(projectKey)).toBe(raw)
    expect(storage.getItem(settingKey)).toBe('1')
    storage.removeItem(settingKey)

    const external = structuredClone(doc)
    external.topics[0].text = 'New disk text'
    storage.setItem = (key, value) => {
      if (key === STORAGE_KEYS.session(id)) {
        write(projectKey, JSON.stringify(external))
        throw new Error('TEST_CAMERA_QUOTA')
      }
      write(key, value)
    }
    expect(inspectNativeCloseState('new-disk').decision).toBe('allow-clean')
    expect((await finalizeNativeCleanClose('new-disk')).ok).toBe(false)
    expect(storage.getItem(projectKey)).toBe(JSON.stringify(external))
    expect(storage.getItem(settingKey)).toBeNull()
    write(projectKey, raw)

    expect(inspectNativeCloseState('new-editor').decision).toBe('allow-clean')
    const close = finalizeNativeCleanClose('new-editor')
    useApp.setState({ editor: { sessionId: 'close-test-editor', nodeId: doc.central_topic_id, field: 'title', baseText: doc.name, draft: 'New editor text' } })
    expect((await close).ok).toBe(false)
    expect(useApp.getState().editor?.draft).toBe('New editor text')
    expect(storage.getItem(settingKey)).toBeNull()
  })

  it('discard keeps the window open until removal of the approved draft is verified', async () => {
    const doc = newProjectDoc('Discard on quota')
    const id = doc.project_id
    const raw = JSON.stringify(doc)
    const journalKey = STORAGE_KEYS.journal(id)
    storage.setItem(STORAGE_KEYS.project(id), raw)
    storage.setItem(STORAGE_KEYS.registry, JSON.stringify([{ id }]))
    useApp.setState({ doc, persistedRaw: raw, saveStatus: 'clean',
      editor: { sessionId: 'close-test-editor', nodeId: doc.central_topic_id, field: 'title', baseText: doc.name, draft: 'Approved draft' } })
    const journal = JSON.stringify({
      journal_schema_version: 1, project_id: id, node_id: doc.central_topic_id, field: 'title',
      base_document_revision: doc.document_revision, base_field_value: doc.name, editor_session_id: 'close-test-editor', draft_text: 'Approved draft',
    })
    storage.setItem(journalKey, journal)
    const write = storage.setItem
    storage.setItem = (key, value) => {
      if (key === STORAGE_KEYS.session(id)) throw new Error('TEST_CAMERA_QUOTA')
      write(key, value)
    }
    const remove = storage.removeItem
    storage.removeItem = key => { if (key !== journalKey) remove(key) }
    expect(inspectNativeCloseState('blocked-discard').decision).toBe('confirm-dirty')
    expect((await discardAndPrepareNativeClose('blocked-discard')).ok).toBe(false)
    expect(storage.getItem(journalKey)).toBe(journal)
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBeNull()
    expect(useApp.getState().editor?.draft).toBe('Approved draft')

    storage.removeItem = remove
    expect(inspectNativeCloseState('allowed-discard').decision).toBe('confirm-dirty')
    expect(await discardAndPrepareNativeClose('allowed-discard')).toMatchObject({ ok: true, sessionWarning: expect.any(String) })
    expect(storage.getItem(journalKey)).toBeNull()
    expect(storage.getItem(STORAGE_KEYS.project(id))).toBe(raw)
  })
  it('discard clears a journal written by the approved editor before or during the confirmation', async () => {
    const doc = newProjectDoc('Discard session')
    const raw = JSON.stringify(doc)
    const key = STORAGE_KEYS.journal(doc.project_id)
    storage.setItem(STORAGE_KEYS.project(doc.project_id), raw)
    storage.setItem(STORAGE_KEYS.registry, JSON.stringify([{ id: doc.project_id }]))
    useApp.setState({ doc, persistedRaw: raw, saveStatus: 'clean' })
    useApp.getState().startEdit(doc.central_topic_id, 'title')
    useApp.getState().updateDraft('A')
    const firstEditor = useApp.getState().editor!
    expect(inspectNativeCloseState('late-draft').decision).toBe('confirm-dirty')
    expect(storage.getItem(key)).toBeNull()
    const waitForDraft = async () => {
      for (let n = 0; n < 50 && !storage.getItem(key); n++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(JSON.parse(storage.getItem(key)!).editor_session_id).toBe(useApp.getState().editor?.sessionId)
    }
    await waitForDraft()
    expect((await discardAndPrepareNativeClose('late-draft')).ok).toBe(true)
    expect(storage.getItem(key)).toBeNull()

    useApp.getState().startEdit(doc.central_topic_id, 'title')
    useApp.getState().updateDraft('Previous autosaved draft')
    expect(useApp.getState().editor?.sessionId).not.toBe(firstEditor.sessionId)
    await waitForDraft()
    useApp.getState().updateDraft('Latest draft before debounce')
    expect(inspectNativeCloseState('older-draft').decision).toBe('confirm-dirty')
    expect((await discardAndPrepareNativeClose('older-draft')).ok).toBe(true)
    expect(storage.getItem(key)).toBeNull()
    expect(storage.getItem(STORAGE_KEYS.project(doc.project_id))).toBe(raw)
  })

  it('discard refuses a different editor journal arriving during camera save and keeps both drafts safe', async () => {
    const doc = newProjectDoc('Foreign draft')
    const id = doc.project_id
    const raw = JSON.stringify(doc)
    storage.setItem(STORAGE_KEYS.project(id), raw)
    storage.setItem(STORAGE_KEYS.registry, JSON.stringify([{ id }]))
    useApp.setState({ doc, persistedRaw: raw, saveStatus: 'clean' })
    useApp.getState().startEdit(doc.central_topic_id, 'title')
    useApp.getState().updateDraft('Current unsaved text')
    expect(inspectNativeCloseState('different-writer').decision).toBe('confirm-dirty')
    const journalKey = STORAGE_KEYS.journal(id)
    const foreign = JSON.stringify({
      journal_schema_version: 1, editor_session_id: 'other-editor', project_id: id, node_id: doc.central_topic_id,
      field: 'title', base_document_revision: doc.document_revision, base_field_value: doc.name,
      draft_text: 'Current unsaved text', timestamp: new Date().toISOString(),
    })
    const write = storage.setItem
    storage.setItem = (key, value) => {
      if (key === STORAGE_KEYS.session(id)) write(journalKey, foreign)
      write(key, value)
    }
    expect((await discardAndPrepareNativeClose('different-writer')).ok).toBe(false)
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBeNull()
    expect(storage.getItem(journalKey)).toBe(foreign)
    expect(useApp.getState().editor?.draft).toBe('Current unsaved text')
    await new Promise(resolve => setTimeout(resolve, 550))
    expect(storage.getItem(journalKey)).toBe(foreign)
    expect(storage.getItem(STORAGE_KEYS.project(id))).toBe(raw)
  })
  it.each(['foreign journal', 'own journal', 'journal disabled', 'old request', 'different generation', 'different epoch', 'different editor'])(
    'cancelling close handles a reverted editor with %s', async (scenario) => {
      const doc = newProjectDoc('Reverted editor')
      const id = doc.project_id
      const raw = JSON.stringify(doc)
      const key = STORAGE_KEYS.journal(id)
      const meta = metaFromDoc(doc)
      storage.setItem(STORAGE_KEYS.project(id), raw)
      storage.setItem(STORAGE_KEYS.registry, JSON.stringify([meta]))
      useApp.setState({
        doc, persistedRaw: raw, registry: [meta], saveStatus: 'clean', _journalTimer: null,
        settings: { ...defaultSettings(), autosaveEnabled: false, draftJournalEnabled: true },
      })
      expect(useApp.getState().renameProject('Pending project rename')).toBe(true)
      useApp.getState().startEdit(doc.central_topic_id, 'title')
      const editor = useApp.getState().editor!
      const baseline = JSON.stringify({
        journal_schema_version: 1, project_id: id, node_id: editor.nodeId, field: editor.field,
        base_document_revision: doc.document_revision, base_field_value: editor.baseText,
        editor_session_id: scenario === 'own journal' ? editor.sessionId : 'other-editor',
        draft_text: 'Previously journaled text', timestamp: new Date().toISOString(),
      })
      storage.setItem(key, baseline)
      const originalTimeout = globalThis.setTimeout
      const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>()
      const writes: string[] = []
      const setItem = storage.setItem
      storage.setItem = (name, value) => {
        if (name === key) writes.push(value)
        setItem(name, value)
      }
      globalThis.setTimeout = ((callback: () => void, ms?: number) => {
        if (ms !== 500) return originalTimeout(callback, ms)
        const timer = originalTimeout(() => {}, 30_000)
        callbacks.set(timer, callback)
        return timer
      }) as typeof setTimeout

      const requestId = 'reverted-editor-close'
      try {
        useApp.getState().updateDraft('Temporary text')
        useApp.getState().updateDraft(editor.baseText)
        const oldTimer = useApp.getState()._journalTimer!
        expect(callbacks.has(oldTimer)).toBe(true)
        expect(inspectNativeCloseState(requestId).decision).toBe('confirm-dirty')
        const st = useApp.getState()
        if (scenario === 'journal disabled') useApp.setState({ settings: { ...st.settings, draftJournalEnabled: false } })
        if (scenario === 'different generation') useApp.setState({ generation: st.generation + 1 })
        if (scenario === 'different epoch') useApp.setState({ registry: [{ ...meta, storageEpoch: 'replacement-epoch' }] })
        if (scenario === 'different editor') useApp.setState({ editor: { ...st.editor!, sessionId: 'new-editor' } })

        const beforeCancel = useApp.getState()
        const invalid = scenario === 'old request' || scenario.startsWith('different')
        expect(cancelNativeClose(scenario === 'old request' ? 'old-close' : requestId)).toEqual({ ok: true })
        const currentTimer = useApp.getState()._journalTimer
        if (invalid) {
          expect(currentTimer).toBe(oldTimer)
          expect(writes).toEqual([])
          expect(storage.getItem(key)).toBe(baseline)
        } else {
          // Exercise a callback that was already queued to run before Cancel replaced or cleared it.
          callbacks.get(oldTimer)!()
          await withStorageWrite(() => {})
          if (scenario === 'journal disabled') {
            expect(useApp.getState()._journalTimer).toBeNull()
            expect(writes).toEqual([])
            expect(storage.getItem(key)).toBe(baseline)
          } else {
            expect(currentTimer).not.toBeNull()
            expect(currentTimer).not.toBe(oldTimer)
            expect(useApp.getState()._journalTimer).toBe(currentTimer)
            expect(writes).toEqual([])
            callbacks.get(currentTimer!)!()
            await withStorageWrite(() => {})
            if (scenario === 'own journal') {
              expect(writes).toHaveLength(1)
              expect(JSON.parse(storage.getItem(key)!)).toMatchObject({
                draft_text: editor.baseText, editor_session_id: editor.sessionId,
              })
            } else {
              expect(writes).toEqual([])
              expect(storage.getItem(key)).toBe(baseline)
            }
            expect(useApp.getState()._journalTimer).toBeNull()
          }
        }
        expect(useApp.getState().editor).toBe(beforeCancel.editor)
        expect(useApp.getState().doc).toBe(beforeCancel.doc)
        expect(useApp.getState().saveStatus).toBe('dirty')
        expect(storage.getItem(STORAGE_KEYS.project(id))).toBe(raw)
        expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBeNull()
      } finally {
        globalThis.setTimeout = originalTimeout
        for (const timer of callbacks.keys()) clearTimeout(timer)
        useApp.setState({ _journalTimer: null })
        cancelNativeClose(requestId)
      }
    },
  )

  it.each(['discard', 'cancel before timer', 'cancel after delayed enqueue', 'cancel after enqueue', 'expired discard'])(
    'a queued draft preserves a different session on %s', async (scenario) => {
      const doc = newProjectDoc('Deferred native journal')
      const id = doc.project_id
      const raw = JSON.stringify(doc)
      const key = STORAGE_KEYS.journal(id)
      storage.setItem(STORAGE_KEYS.project(id), raw)
      storage.setItem(STORAGE_KEYS.registry, JSON.stringify([{ id }]))
      useApp.setState({ doc, persistedRaw: raw, saveStatus: 'clean' })

      const locks = navigator.locks
      const request = locks.request
      let tail = Promise.resolve()
      let release!: () => void
      let queued = 0
      locks.request = ((_name: string, _options: LockOptions, action: LockGrantedCallback) => {
        queued++
        const result = tail.then(() => action(null))
        tail = result.then(() => {}, () => {})
        return result
      }) as LockManager['request']
      const foreign = JSON.stringify({
        journal_schema_version: 1, editor_session_id: 'different-session', project_id: id, node_id: doc.central_topic_id,
        field: 'title', base_document_revision: doc.document_revision, draft_text: 'Other session', timestamp: new Date().toISOString(),
      })
      const now = performance.now
      const hold = withStorageWrite(() => new Promise<void>(resolve => { release = resolve }))
      await Promise.resolve()
      try {
        const other = withStorageWrite(() => storage.setItem(key, foreign))
        useApp.getState().startEdit(doc.central_topic_id, 'title')
        useApp.getState().updateDraft('Current session')
        const requestId = 'queued-foreign'
        const cancelBeforeTimer = scenario === 'cancel before timer'
        const inspectBeforeEnqueue = cancelBeforeTimer || scenario === 'cancel after delayed enqueue'
        if (inspectBeforeEnqueue) expect(inspectNativeCloseState(requestId).decision).toBe('confirm-dirty')
        if (cancelBeforeTimer) expect(cancelNativeClose(requestId).ok).toBe(true)
        for (let n = 0; n < 50 && queued < 3; n++) await new Promise(resolve => setTimeout(resolve, 20))
        expect(queued).toBe(3)
        if (!inspectBeforeEnqueue) expect(inspectNativeCloseState(requestId).decision).toBe('confirm-dirty')
        expect(storage.getItem(key)).toBeNull()
        const cancelling = scenario.startsWith('cancel')
        const discard = cancelling ? null : discardAndPrepareNativeClose(requestId)
        if (cancelling && !cancelBeforeTimer) expect(cancelNativeClose(requestId).ok).toBe(true)
        if (scenario === 'expired discard') performance.now = () => now.call(performance) + 6000
        release()
        await other
        await tail
        if (discard) expect((await discard).ok).toBe(false)
        expect(storage.getItem(key)).toBe(foreign)
        expect(useApp.getState().editor?.draft).toBe('Current session')
        expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBeNull()
        // The resumed timer must still leave the other session's journal intact.
        await new Promise(resolve => setTimeout(resolve, 550))
        await withStorageWrite(() => expect(storage.getItem(key)).toBe(foreign))
        expect(storage.getItem(STORAGE_KEYS.project(id))).toBe(raw)
      } finally {
        release()
        await hold
        await tail
        performance.now = now
        locks.request = request
      }
    },
  )
})

function createMemoryJournal(): TransferJournalHooks & { state: () => TransferJournalState | null } {
  let journal: TransferJournalState | null = null
  return {
    state: () => journal,
    async getState() { return journal },
    async prepareRollback(_transferId, pending) {
      if (!journal) return { ok: false, error: 'Missing' }
      journal.rollbackPending = pending
      return { ok: true }
    },
    async prepareFinalFlag() {
      if (!journal) return { ok: false, error: 'Missing' }
      journal.finalFlagOwned = true
      return { ok: true }
    },
    async beginOrResume(packageSha256, totalKeys, replaceLegacyId) {
      if (journal?.status === 'completed') return { ok: false, error: 'Already completed' }
      if (journal?.status === 'in_progress' && journal.transferId !== replaceLegacyId) {
        if (journal.packageSha256 !== packageSha256) return { ok: false, error: 'Mismatch' }
        return { ok: true }
      }
      journal = {
        version: 2, transferId: crypto.randomUUID(), packageSha256, status: 'in_progress',
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        completedKeys: [], keyDigests: {}, totalKeys, lastError: null,
      }
      return { ok: true }
    },
    async blockIntent(_transferId, key) {
      if (!journal) return { ok: false, error: 'Missing' }
      journal.blockedKey = key
      return { ok: true }
    },
    async prepareKey(intent) {
      if (!journal || journal.transferId !== intent.transferId) return { ok: false, error: 'Not active' }
      journal.pendingKey = intent
      return { ok: true }
    },
    async markKey(intent) {
      if (!journal || journal.pendingKey?.key !== intent.key || journal.pendingKey.sha256 !== intent.sha256) {
        return { ok: false, error: 'Not active' }
      }
      journal.completedKeys.push(intent.key)
      journal.keyDigests[intent.key] = intent.sha256
      delete journal.pendingKey
      return { ok: true }
    },
    async complete() {
      if (!journal) return { ok: false, error: 'Missing' }
      journal.status = 'completed'
      return { ok: true }
    },
    async rollback(_transferId, reason) {
      if (journal) {
        journal.status = 'rolled_back'
        journal.lastError = reason
        delete journal.rollbackPending
        delete journal.finalFlagOwned
        delete journal.pendingKey
      }
      return { ok: true }
    },
  }
}

describe('Workspace Transfer v1 Integrity, Resume & Rollback', () => {
  it('T01 + T02: read-only export, SHA-256 tamper guard, non-empty guard, interrupt+resume, and cancel rollback', async () => {
    const doc = newProjectDoc('Dự án Nguồn 🚀')
    const sourceStorage = createMemoryStorage({
      [STORAGE_KEYS.registry]: JSON.stringify([{ id: doc.project_id, name: doc.name, createdAt: doc.created_at, updatedAt: doc.updated_at, revision: 1, lastOpened: doc.updated_at, nodeCount: 1 }]),
      [STORAGE_KEYS.settings]: JSON.stringify({ lastProjectId: doc.project_id }),
      [STORAGE_KEYS.project(doc.project_id)]: JSON.stringify(doc),
      [STORAGE_KEYS.backup(doc.project_id)]: JSON.stringify([doc]),
      [STORAGE_KEYS.journal(doc.project_id)]: JSON.stringify({ journal_schema_version: 1, project_id: doc.project_id, node_id: doc.central_topic_id, field: 'title', base_document_revision: 1, draft_text: 'Draft Recovery', timestamp: new Date().toISOString() }),
      [STORAGE_KEYS.session(doc.project_id)]: JSON.stringify({ camera: { x: 42, y: 84, zoom: 1.5 } }),
      [STORAGE_KEYS.trash]: JSON.stringify([{ id: 't-old', name: 'Thùng rác cũ', deletedAt: new Date().toISOString(), doc }]),
    })
    setupBrowserGlobals(sourceStorage)

    const pkg = await exportWorkspaceReadonly(sourceStorage, EXPECTED_LOCAL_ORIGIN)
    expect(pkg.format).toBe('openmindmap-workspace-transfer')
    expect(pkg.cleanShutdown).toBeNull()
    expect(pkg.summary.projects).toBe(1)
    expect(pkg.summary.journals).toBe(1)
    expect(pkg.summary.trashCount).toBe(1)
    expect(sourceStorage.getItem(STORAGE_KEYS.cleanShutdown)).toBeNull() // read-only: did not mutate source

    // 1. Corrupt SHA-256 detection
    const tampered = JSON.parse(JSON.stringify(pkg)) as typeof pkg
    tampered.entries[0].value = tampered.entries[0].value + ' '
    const tamperRes = await validateTransferPackage(JSON.stringify(tampered), EXPECTED_LOCAL_ORIGIN)
    expect(tamperRes.ok).toBe(false)
    if (!tamperRes.ok) expect(tamperRes.code).toBe('digest_mismatch')

    // 2. Non-empty target rejected cleanly
    const nonEmptyTarget = createMemoryStorage({ [STORAGE_KEYS.registry]: '[{"id":"x"}]' })
    const j1 = createMemoryJournal()
    const nonEmptyRes = await importWorkspaceTransactional(pkg, nonEmptyTarget, j1)
    expect(nonEmptyRes.ok).toBe(false)
    expect(nonEmptyRes.code).toBe('non_empty_target')
    expect(nonEmptyTarget.getItem(STORAGE_KEYS.registry)).toBe('[{"id":"x"}]')

    // 3. Interrupt mid-transfer -> Resume completes cleanly
    const targetStorage = createMemoryStorage()
    const j2 = createMemoryJournal()
    const interrupted = await importWorkspaceTransactional(pkg, targetStorage, j2, {
      shouldAbortBeforeKey: (_k, count) => (count === 3 ? 'interrupt' : false),
    })
    expect(interrupted.ok).toBe(false)
    expect(interrupted.code).toBe('interrupted')
    expect(j2.state()?.status).toBe('in_progress')
    expect(j2.state()?.completedKeys.length).toBe(3)

    const resumed = await importWorkspaceTransactional(pkg, targetStorage, j2)
    expect(resumed.ok).toBe(true)
    expect(resumed.resumedFromKeys).toBe(3)
    expect(resumed.writtenKeys).toBe(pkg.entries.length - 3)
    expect(j2.state()?.status).toBe('completed')
    expect(targetStorage.getItem(STORAGE_KEYS.cleanShutdown)).toBeNull()
    expect(targetStorage.getItem(STORAGE_KEYS.journal(doc.project_id))).toContain('Draft Recovery')

    // 4. Already-completed guard
    const replay = await importWorkspaceTransactional(pkg, targetStorage, j2)
    expect(replay.ok).toBe(false)
    expect(replay.code).toBe('already_completed')

    // 5. Cancel rollback leaves target completely clean
    const cancelTarget = createMemoryStorage()
    const j3 = createMemoryJournal()
    const cancelled = await importWorkspaceTransactional(pkg, cancelTarget, j3, {
      shouldAbortBeforeKey: (_k, count) => (count === 2 ? 'cancel' : false),
    })
    expect(cancelled.ok).toBe(false)
    expect(cancelled.code).toBe('cancelled')
    expect(cancelled.rolledBackKeys).toBe(2)
    expect(Object.keys(cancelTarget.dump())).toEqual([])
    expect(j3.state()?.status).toBe('rolled_back')
  })
})


it('transfer resumes the unacknowledged next key and rejects a different value', async () => {
  const clean = STORAGE_KEYS.cleanShutdown
  const a = STORAGE_KEYS.project('a')
  const b = STORAGE_KEYS.project('b')
  const source = createMemoryStorage({ [a]: 'project A', [b]: 'project B', [clean]: '1' })
  const pkg = await exportWorkspaceReadonly(source, EXPECTED_LOCAL_ORIGIN)
  const journal = createMemoryJournal()
  const target = createMemoryStorage()
  await journal.beginOrResume(pkg.digestSha256, pkg.entries.length)
  target.setItem(a, 'foreign value')
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('non_empty_target')
  expect(target.dump()).toEqual({ [a]: 'foreign value' })
  target.setItem(a, 'project A')
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('non_empty_target')
  expect(journal.state()?.completedKeys).toEqual([])
  target.removeItem(a)
  const entry = pkg.entries.find(entry => entry.key === a)!
  await journal.prepareKey({ transferId: journal.state()!.transferId, key: a, sha256: entry.sha256 })
  target.setItem(a, entry.value)
  const result = await importWorkspaceTransactional(pkg, target, journal)
  expect(result.ok).toBe(true)
  expect(result.resumedFromKeys).toBe(1)
  expect(result.writtenKeys).toBe(1)
  expect(target.dump()).toEqual(source.dump())
})

it('transfer persists rollback intent and resumes cleanup after a removal fails', async () => {
  const clean = STORAGE_KEYS.cleanShutdown
  const a = STORAGE_KEYS.project('a')
  const b = STORAGE_KEYS.project('b')
  const foreign = 'unrelated'
  const source = createMemoryStorage({ [a]: 'project A', [b]: 'project B', [clean]: '1' })
  const pkg = await exportWorkspaceReadonly(source, EXPECTED_LOCAL_ORIGIN)
  const journal = createMemoryJournal()
  const target = createMemoryStorage({ [foreign]: 'keep' })
  const write = target.setItem
  target.setItem = (key, value) => {
    if (key === clean) throw new Error('TEST_FLAG_QUOTA')
    write(key, value)
  }
  const remove = target.removeItem
  target.removeItem = key => {
    if (key === a) throw new Error('TEST_ROLLBACK_REMOVE')
    remove(key)
  }
  const failed = await importWorkspaceTransactional(pkg, target, journal)
  expect(failed.code).toBe('rollback_pending')
  expect(journal.state()?.rollbackPending?.keys).toEqual([a, b])
  expect(journal.state()?.status).toBe('in_progress')
  expect(target.dump()).toEqual({ [foreign]: 'keep', [a]: 'project A' })
  target.setItem = write
  target.removeItem = remove
  target.setItem(a, 'external edit')
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('rollback_pending')
  expect(target.getItem(a)).toBe('external edit')
  target.setItem(a, 'project A')
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('write_verify_failed')
  expect(journal.state()?.status).toBe('rolled_back')
  expect(target.dump()).toEqual({ [foreign]: 'keep' })
  expect((await importWorkspaceTransactional(pkg, target, journal)).ok).toBe(true)
  expect(target.dump()).toEqual({ [foreign]: 'keep', ...source.dump() })
})

it('transfer reconciles a lost completion reply against the exact stored package', async () => {
  const project = STORAGE_KEYS.project('note')
  const source = createMemoryStorage({ [project]: 'note' })
  const pkg = await exportWorkspaceReadonly(source, EXPECTED_LOCAL_ORIGIN)
  const journal = createMemoryJournal()
  const complete = journal.complete
  journal.complete = async args => {
    await complete(args)
    throw new Error('TEST_LOST_REPLY')
  }
  const target = createMemoryStorage()
  expect((await importWorkspaceTransactional(pkg, target, journal)).ok).toBe(true)
  expect(target.dump()).toEqual(source.dump())
  const verified = await importWorkspaceTransactional(pkg, target, journal)
  expect(verified.code).toBe('already_completed')
  expect(verified.verifiedComplete).toBe(true)
  target.setItem(project, 'edited')
  expect((await importWorkspaceTransactional(pkg, target, journal)).verifiedComplete).toBe(false)
  expect(target.getItem(project)).toBe('edited')
})

it('transfer leaves a nonempty target and journal untouched before beginning, including legacy state', async () => {
  const a = STORAGE_KEYS.project('identical')
  const clean = STORAGE_KEYS.cleanShutdown
  const source = createMemoryStorage({ [a]: 'existing bytes', [clean]: '1' })
  const pkg = await exportWorkspaceReadonly(source, EXPECTED_LOCAL_ORIGIN)
  const journal = createMemoryJournal()
  const target = createMemoryStorage({ [a]: 'existing bytes' })
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('non_empty_target')
  expect(journal.state()).toBeNull()
  expect(target.dump()).toEqual({ [a]: 'existing bytes' })
  target.removeItem(a)
  target.setItem(clean, '1')
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('non_empty_target')
  expect(journal.state()).toBeNull()
  target.removeItem(clean)

  await journal.beginOrResume(pkg.digestSha256, pkg.entries.length)
  const legacy = journal.state()!
  legacy.version = 1
  target.setItem(a, 'existing bytes')
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('resume_integrity_failed')
  expect(journal.state()).toBe(legacy)
  expect(target.dump()).toEqual({ [a]: 'existing bytes' })
  target.removeItem(a)
  expect((await importWorkspaceTransactional(pkg, target, journal)).ok).toBe(true)
  expect(journal.state()?.version).toBe(2)
  expect(journal.state()?.transferId).not.toBe(legacy.transferId)
  expect(target.dump()).toEqual(source.dump())
})

it('transfer reconciles lost begin, prepare, ACK, and clean-flag replies by reading durable state', async () => {
  const a = STORAGE_KEYS.project('reply-loss')
  const source = createMemoryStorage({ [a]: 'written one time', [STORAGE_KEYS.cleanShutdown]: '1' })
  const pkg = await exportWorkspaceReadonly(source, EXPECTED_LOCAL_ORIGIN)
  const target = createMemoryStorage()
  const journal = createMemoryJournal()
  const begin = journal.beginOrResume
  const prepareKey = journal.prepareKey
  const markKey = journal.markKey
  const prepareFinalFlag = journal.prepareFinalFlag
  const simulateLostReply = () => { throw new Error('TEST_LOST_REPLY') }
  journal.beginOrResume = async (...args) => { await begin(...args); return simulateLostReply() }
  journal.prepareKey = async (...args) => { await prepareKey(...args); return simulateLostReply() }
  journal.markKey = async (...args) => { await markKey(...args); return simulateLostReply() }
  journal.prepareFinalFlag = async (...args) => { await prepareFinalFlag(...args); return simulateLostReply() }
  expect(await importWorkspaceTransactional(pkg, target, journal)).toMatchObject({ ok: true, writtenKeys: 1 })
  expect(journal.state()?.pendingKey).toBeUndefined()
  expect(journal.state()?.completedKeys).toEqual([a])
  expect(target.dump()).toEqual(source.dump())
})

it('transfer keeps data that appears after reservation and refuses to claim equal bytes on retry', async () => {
  const key = STORAGE_KEYS.project('external-write')
  const source = createMemoryStorage({ [key]: 'same bytes' })
  const pkg = await exportWorkspaceReadonly(source, EXPECTED_LOCAL_ORIGIN)
  const target = createMemoryStorage()
  const journal = createMemoryJournal()
  const prepare = journal.prepareKey
  journal.prepareKey = async intent => {
    const result = await prepare(intent)
    target.setItem(key, 'same bytes')
    return result
  }
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('non_empty_target')
  expect(journal.state()?.blockedKey).toBe(key)
  expect((await importWorkspaceTransactional(pkg, target, journal)).code).toBe('non_empty_target')
  expect(journal.state()?.completedKeys).toEqual([])
  expect(target.dump()).toEqual(source.dump())
})
