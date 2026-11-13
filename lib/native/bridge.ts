import {
  useApp,
  inspectNativeCloseState,
  finalizeNativeCleanClose,
  commitAndFlushNativeClose,
  discardAndPrepareNativeClose,
  cancelNativeClose,
} from '../store'
import {
  buildCatalogItems,
  buildMenuStateSnapshot,
  hasBlockingDialogOpen,
  type MenuCommandId,
  type MenuStateSnapshot,
} from '../core/menuCatalog'

interface NativeHostMeta {
  platform: 'macos'
  appVersion?: string
  transferMode?: boolean
  transferRole?: 'source' | 'target'
}

interface WebKitHandlers {
  ommMenuState?: { postMessage: (msg: unknown) => void }
  ommDownload?: { postMessage: (msg: unknown) => void }
  ommTransfer?: { postMessage: (msg: unknown) => void }
  ommLog?: { postMessage: (msg: unknown) => void }
}

interface ExecuteCommandRequest {
  commandId: MenuCommandId
  requestId?: string
  viewSession?: string
  expectedProjectGeneration?: number
  targetId?: string
}

export interface ExecuteCommandResult {
  ok: boolean
  handled: boolean
  deduplicated?: boolean
  reason?: string
  generation: number
  state: MenuStateSnapshot
}

declare global {
  interface Window {
    __OMM_NATIVE_MACOS__?: NativeHostMeta
    webkit?: { messageHandlers?: WebKitHandlers }
    __ommBridge?: {
      viewSession: string
      getState: () => MenuStateSnapshot
      executeCommand: (req: ExecuteCommandRequest) => ExecuteCommandResult
      prepareNativeClose: (reason: 'window-close' | 'app-quit') => ReturnType<typeof inspectNativeCloseState>
      finalizeCleanClose: () => ReturnType<typeof finalizeNativeCleanClose>
      commitAndFlushBeforeClose: () => ReturnType<typeof commitAndFlushNativeClose>
      discardAndPrepareClose: () => ReturnType<typeof discardAndPrepareNativeClose>
      cancelNativeClose: () => ReturnType<typeof cancelNativeClose>
    }
    __ommResolveNativeDownload?: (res: { id: string; ok: boolean; cancelled?: boolean; path?: string | null; error?: string | null }) => void
  }
}

export function isNativeMacOS(): boolean {
  return typeof window !== 'undefined' && window.__OMM_NATIVE_MACOS__?.platform === 'macos'
}

const processedRequestIds = new Set<string>()
const requestIdOrder: string[] = []

function recordRequestId(requestId: string): boolean {
  if (processedRequestIds.has(requestId)) return false
  processedRequestIds.add(requestId)
  requestIdOrder.push(requestId)
  if (requestIdOrder.length > 200) {
    const oldest = requestIdOrder.shift()
    if (oldest) processedRequestIds.delete(oldest)
  }
  return true
}

export function mountNativeBridge(): () => void {
  if (typeof window === 'undefined') return () => {}

  const viewSession = `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSerialized = ''

  const pushMenuState = (force = false) => {
    const snap = buildMenuStateSnapshot(viewSession, useApp.getState())
    const serialized = JSON.stringify(snap)
    if (!force && serialized === lastSerialized) return snap
    lastSerialized = serialized
    window.webkit?.messageHandlers?.ommMenuState?.postMessage(snap)
    return snap
  }

  const schedulePush = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      pushMenuState()
    }, 16)
  }

  window.__ommResolveNativeDownload = (res) => {
    if (res && !res.ok && !res.cancelled && res.error) {
      useApp.getState().toast('error', 'Lưu tệp thất bại', res.error)
    }
  }

  window.__ommBridge = {
    viewSession,
    getState: () => buildMenuStateSnapshot(viewSession, useApp.getState()),
    executeCommand: (req: ExecuteCommandRequest): ExecuteCommandResult => {
      const st = useApp.getState()
      const currentSnap = buildMenuStateSnapshot(viewSession, st)

      if (req.requestId && !recordRequestId(req.requestId)) {
        return { ok: true, handled: false, deduplicated: true, reason: 'duplicate_request', generation: st.generation, state: currentSnap }
      }
      if (req.viewSession && req.viewSession !== viewSession) {
        return { ok: false, handled: false, reason: 'stale_view_session', generation: st.generation, state: currentSnap }
      }
      if (typeof req.expectedProjectGeneration === 'number' && req.expectedProjectGeneration !== st.generation) {
        return { ok: false, handled: false, reason: 'stale_generation', generation: st.generation, state: currentSnap }
      }
      if (st.transitionBusy || st.leavePrompt || hasBlockingDialogOpen()) {
        return { ok: false, handled: false, reason: 'ui_locked', generation: st.generation, state: currentSnap }
      }

      const item = buildCatalogItems(st).find((c) => c.id === req.commandId)
      if (!item) {
        return { ok: false, handled: false, reason: 'unknown_command', generation: st.generation, state: currentSnap }
      }
      if (item.disabled) {
        return { ok: false, handled: false, reason: 'disabled', generation: st.generation, state: currentSnap }
      }

      item.run(req.targetId)
      const nextSnap = pushMenuState(true)
      return { ok: true, handled: true, generation: useApp.getState().generation, state: nextSnap }
    },
    prepareNativeClose: () => {
      const decision = inspectNativeCloseState()
      pushMenuState(true)
      return decision
    },
    finalizeCleanClose: () => finalizeNativeCleanClose(),
    commitAndFlushBeforeClose: () => commitAndFlushNativeClose(),
    discardAndPrepareClose: () => discardAndPrepareNativeClose(),
    cancelNativeClose: () => {
      const res = cancelNativeClose()
      pushMenuState(true)
      return res
    },
  }

  const unsubStore = useApp.subscribe(() => {
    schedulePush()
  })

  const onFocusOrModal = () => schedulePush()
  document.addEventListener('focusin', onFocusOrModal, true)
  document.addEventListener('focusout', onFocusOrModal, true)

  const observer = new MutationObserver(() => schedulePush())
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal'] })

  pushMenuState(true)

  return () => {
    if (timer) clearTimeout(timer)
    unsubStore()
    observer.disconnect()
    document.removeEventListener('focusin', onFocusOrModal, true)
    document.removeEventListener('focusout', onFocusOrModal, true)
    delete window.__ommBridge
  }
}
