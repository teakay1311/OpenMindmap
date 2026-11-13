import { describe, expect, it, beforeEach } from 'bun:test'
import { newProjectDoc, type ProjectDocV3 } from '../lib/core/types'
import { STORAGE_KEYS } from '../lib/storage/projects'
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
    expect(inspectNativeCloseState().decision).toBe('allow-clean')
    finalizeNativeCleanClose()
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
      editor: { nodeId: doc.central_topic_id, field: 'title', baseText: doc.name, draft: 'Tên Mới Đã Lưu' },
      saveStatus: 'clean',
    })
    expect(inspectNativeCloseState().decision).toBe('confirm-dirty')
    const saveRes = await commitAndFlushNativeClose()
    expect(saveRes.ok).toBe(true)
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBe('1')
    expect(storage.getItem(STORAGE_KEYS.journal(doc.project_id))).toBeNull()
    const savedDoc = JSON.parse(storage.getItem(STORAGE_KEYS.project(doc.project_id))!) as ProjectDocV3
    expect(savedDoc.topics[0].text).toBe('Tên Mới Đã Lưu')
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.settings)!).lastProjectId).toBe(doc.project_id)

    // 3. Conflict blocks closing cleanly
    const curRaw = storage.getItem(STORAGE_KEYS.project(doc.project_id))!
    storage.setItem(STORAGE_KEYS.project(doc.project_id), curRaw.replace('Tên Mới Đã Lưu', 'Xung đột từ tab khác'))
    expect(inspectNativeCloseState().decision).toBe('conflict')

    // 4. Discard clears draft journal and keeps last saved raw + lastProjectId
    storage.setItem(STORAGE_KEYS.project(doc.project_id), curRaw)
    storage.setItem(STORAGE_KEYS.journal(doc.project_id), '{"dummy":1}')
    useApp.setState({
      persistedRaw: curRaw,
      saveStatus: 'dirty',
      editor: { nodeId: doc.central_topic_id, field: 'title', baseText: 'Tên Mới Đã Lưu', draft: 'Bỏ đi' },
    })
    expect(inspectNativeCloseState().decision).toBe('confirm-dirty')
    await discardAndPrepareNativeClose()
    expect(storage.getItem(STORAGE_KEYS.journal(doc.project_id))).toBeNull()
    expect(storage.getItem(STORAGE_KEYS.cleanShutdown)).toBe('1')
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.settings)!).lastProjectId).toBe(doc.project_id)
    expect((JSON.parse(storage.getItem(STORAGE_KEYS.project(doc.project_id))!) as ProjectDocV3).topics[0].text).toBe('Tên Mới Đã Lưu')
    cancelNativeClose()
  })
})

function createMemoryJournal(): TransferJournalHooks & { state: () => TransferJournalState | null } {
  let journal: TransferJournalState | null = null
  return {
    state: () => journal,
    async beginOrResume(packageSha256, totalKeys) {
      if (journal?.status === 'completed') return { ok: false, code: 'already_completed', error: 'Already completed' }
      if (journal?.status === 'in_progress') {
        if (journal.packageSha256 !== packageSha256) return { ok: false, code: 'mismatch_in_progress', error: 'Mismatch' }
        return { ok: true, mode: 'resume', journal }
      }
      journal = {
        version: 1, transferId: 't-1', packageSha256, status: 'in_progress',
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        completedKeys: [], keyDigests: {}, totalKeys, lastError: null,
      }
      return { ok: true, mode: 'start', journal }
    },
    async markKey(key, sha256) {
      if (!journal || journal.status !== 'in_progress') return { ok: false, error: 'Not active' }
      journal.completedKeys.push(key)
      journal.keyDigests[key] = sha256
      return { ok: true }
    },
    async complete() {
      if (!journal) return { ok: false, error: 'Missing' }
      journal.status = 'completed'
      return { ok: true }
    },
    async rollback(reason) {
      if (journal) { journal.status = 'rolled_back'; journal.lastError = reason }
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
