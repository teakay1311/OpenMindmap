'use client'

import React, { useCallback, useEffect, useState } from 'react'
import {
  EXPECTED_LOCAL_ORIGIN,
  WorkspaceTransferPackage,
  TransferJournalState,
  exportWorkspaceReadonly,
  validateTransferPackage,
  importWorkspaceTransactional,
  listExistingWorkspaceKeys,
  type TransferJournalHooks,
} from '../lib/transfer/workspaceTransfer'
import { download } from '../lib/io/exporters'
import { isNativeMacOS } from '../lib/native/bridge'

type TransferBridgeMsg = { ok?: boolean; code?: string; error?: string; journal?: TransferJournalState | null; mode?: 'start' | 'resume'; path?: string }

const pendingNativeCalls = new Map<string, (res: TransferBridgeMsg) => void>()

if (typeof window !== 'undefined') {
  ;(window as unknown as { __ommResolveNativeTransfer?: (env: { reqId: string; result: TransferBridgeMsg }) => void }).__ommResolveNativeTransfer = (env) => {
    const resolve = pendingNativeCalls.get(env.reqId)
    if (resolve) {
      pendingNativeCalls.delete(env.reqId)
      resolve(env.result)
    }
  }
}

function callNativeTransfer(payload: Record<string, unknown>): Promise<TransferBridgeMsg> {
  const wk = (window as unknown as { webkit?: { messageHandlers?: { ommTransfer?: { postMessage: (msg: unknown) => void } } } }).webkit
  if (!wk?.messageHandlers?.ommTransfer) {
    return Promise.resolve({ ok: false, error: 'Chưa kết nối với cầu nối macOS.' })
  }
  const reqId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingNativeCalls.delete(reqId)
      resolve({ ok: false, error: 'Quá thời gian phản hồi journal macOS.' })
    }, 5000)
    pendingNativeCalls.set(reqId, (res) => {
      clearTimeout(timer)
      resolve(res)
    })
    wk.messageHandlers!.ommTransfer!.postMessage({ ...payload, reqId })
  })
}

export function TransferView() {
  const [role] = useState<'source' | 'target'>(() => {
    if (typeof window === 'undefined') return 'target'
    return new URLSearchParams(window.location.search).get('role') === 'source' ? 'source' : 'target'
  })
  const [nativeMac] = useState<boolean>(() => isNativeMacOS())
  const [sourcePkg, setSourcePkg] = useState<WorkspaceTransferPackage | null>(null)
  const [targetPkg, setTargetPkg] = useState<WorkspaceTransferPackage | null>(null)
  const [journal, setJournal] = useState<TransferJournalState | null>(null)
  const [existingCount, setExistingCount] = useState(0)
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'error'; text: string }>({ kind: 'idle', text: '' })
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const refreshTargetState = useCallback(async () => {
    setExistingCount(listExistingWorkspaceKeys(window.localStorage).length)
    if (isNativeMacOS()) {
      const res = await callNativeTransfer({ action: 'getState' })
      if (res.ok) setJournal(res.journal ?? null)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (role === 'source') {
      void exportWorkspaceReadonly(window.localStorage, window.location.origin).then((pkg) => {
        if (active) setSourcePkg(pkg)
      })
    } else {
      void Promise.resolve().then(() => {
        if (active) void refreshTargetState()
      })
    }
    return () => { active = false }
  }, [role, refreshTargetState])

  const handleSaveSourcePackage = async () => {
    if (!sourcePkg) return
    const json = JSON.stringify(sourcePkg, null, 2)
    const fileName = `openmindmap-workspace-transfer-${sourcePkg.createdAt.slice(0, 10)}.json`
    if (nativeMac) {
      const res = await callNativeTransfer({ action: 'savePackageFile', fileName, json })
      if (res.ok) setStatus({ kind: 'ok', text: `Đã lưu gói chuyển dữ liệu (${sourcePkg.summary.totalEntries} khóa).` })
      else if (res.error) setStatus({ kind: 'error', text: res.error })
    } else {
      download(new Blob([json], { type: 'application/json' }), fileName)
      setStatus({ kind: 'ok', text: `Đã tải xuống ${fileName}. Hãy mở OpenMindmap macOS ở chế độ chuyển dữ liệu để nạp gói này.` })
    }
  }

  const handleSelectPackageFile = async (file: File) => {
    const text = await file.text()
    const check = await validateTransferPackage(text, window.location.origin === EXPECTED_LOCAL_ORIGIN ? EXPECTED_LOCAL_ORIGIN : window.location.origin)
    if (!check.ok) {
      setTargetPkg(null)
      setStatus({ kind: 'error', text: check.message })
      return
    }
    setTargetPkg(check.pkg)
    setStatus({ kind: 'idle', text: `Đã kiểm tra SHA-256 hợp lệ: ${check.pkg.summary.projects} dự án, ${check.pkg.summary.journals} bản nháp, ${check.pkg.summary.trashCount} thùng rác.` })
  }

  const handleRunImport = async () => {
    if (!targetPkg) return
    setStatus({ kind: 'busy', text: 'Đang nạp và xác minh SHA-256 từng khóa dữ liệu…' })
    setProgress({ done: 0, total: targetPkg.entries.length })

    const hooks: TransferJournalHooks = nativeMac
      ? {
          beginOrResume: async (packageSha256, totalKeys) => {
            const res = await callNativeTransfer({ action: 'beginOrResume', packageSha256, totalKeys })
            return res.ok && res.journal
              ? { ok: true, mode: res.mode ?? 'start', journal: res.journal }
              : { ok: false, code: res.code, error: res.error ?? 'Không khởi tạo được journal.' }
          },
          markKey: async (key, sha256) => {
            const res = await callNativeTransfer({ action: 'markKey', key, sha256 })
            return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Lỗi ghi journal.' }
          },
          complete: async () => {
            const res = await callNativeTransfer({ action: 'complete' })
            return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Lỗi hoàn tất journal.' }
          },
          rollback: async (reason) => {
            const res = await callNativeTransfer({ action: 'rollback', reason })
            return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Lỗi rollback.' }
          },
        }
      : {
          beginOrResume: async () => ({ ok: false, error: 'Chế độ đích chỉ chạy trong ứng dụng OpenMindmap macOS.' }),
          markKey: async () => ({ ok: false, error: 'Unsupported' }),
          complete: async () => ({ ok: false, error: 'Unsupported' }),
          rollback: async () => ({ ok: false, error: 'Unsupported' }),
        }

    const result = await importWorkspaceTransactional(targetPkg, window.localStorage, hooks, {
      onProgress: (done, total) => setProgress({ done, total }),
    })

    await refreshTargetState()
    if (result.ok) {
      setStatus({ kind: 'ok', text: result.message })
    } else {
      setStatus({ kind: 'error', text: result.message })
    }
  }

  const handleOpenMainApp = async () => {
    await callNativeTransfer({ action: 'exitTransferToApp' })
  }

  return (
    <main className="min-h-dvh bg-[var(--bg)] px-6 py-10 text-[var(--text)]">
      <div className="mx-auto max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-md">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
          <div>
            <h1 className="text-[18px] font-semibold">Chuyển dữ liệu không gian làm việc OpenMindmap</h1>
            <p className="mt-1 text-[12.5px] text-[var(--text2)]">
              Công cụ nâng cấp một lần tại loopback cục bộ ({EXPECTED_LOCAL_ORIGIN}) — hoàn toàn không gửi dữ liệu ra mạng.
            </p>
          </div>
          <span className="rounded-md bg-[var(--accentSoft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
            {role === 'source' ? 'Nguồn trình duyệt (chỉ đọc)' : 'Ứng dụng macOS đích (tiền khởi tạo)'}
          </span>
        </div>

        {role === 'source' ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 text-[13px]">
              <div className="font-medium">Ảnh chụp chỉ đọc từ trình duyệt hiện tại</div>
              {sourcePkg ? (
                <ul className="mt-2 space-y-1 text-[12.5px] text-[var(--text2)]">
                  <li>Dự án: <strong>{sourcePkg.summary.projects}</strong> · Bản sao lưu: <strong>{sourcePkg.summary.backups}</strong></li>
                  <li>Bản nháp Recovery: <strong>{sourcePkg.summary.journals}</strong> · Thùng rác: <strong>{sourcePkg.summary.trashCount}</strong></li>
                  <li>Phiên camera: <strong>{sourcePkg.summary.sessions}</strong> · cleanShutdown gốc: <code>{sourcePkg.cleanShutdown ?? 'null (chưa tắt sạch)'}</code></li>
                  <li>SHA-256 gói: <code className="break-all text-[11px]">{sourcePkg.digestSha256}</code></li>
                </ul>
              ) : (
                <p className="mt-2 text-[12px] text-[var(--text3)]">Đang đọc dữ liệu cục bộ dưới khóa ghi an toàn…</p>
              )}
            </div>
            <button
              type="button"
              disabled={!sourcePkg || sourcePkg.summary.totalEntries === 0}
              onClick={() => void handleSaveSourcePackage()}
              className="h-10 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--onAccent)] hover:bg-[var(--accentStrong)] disabled:opacity-40"
            >
              Xuất gói chuyển dữ liệu có chữ ký SHA-256…
            </button>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 text-[12.5px] text-[var(--text2)]">
              <div>Trạng thái kho dữ liệu đích: <strong>{existingCount}</strong> khóa hiện có</div>
              {journal && (
                <div className="mt-1">
                  Journal chuyển dữ liệu: <code>{journal.status}</code> ({journal.completedKeys.length}/{journal.totalKeys} khóa)
                </div>
              )}
            </div>

            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--border)] p-6 text-center hover:border-[var(--accent)]">
              <span className="text-[13px] font-medium">Chọn tệp gói chuyển dữ liệu (<code>openmindmap-workspace-transfer-*.json</code>)</span>
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleSelectPackageFile(f)
                }}
              />
            </label>

            {targetPkg && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4 text-[12.5px]">
                <div>Dự án: <strong>{targetPkg.summary.projects}</strong> · Backup: <strong>{targetPkg.summary.backups}</strong> · Recovery journal: <strong>{targetPkg.summary.journals}</strong> · Trash: <strong>{targetPkg.summary.trashCount}</strong></div>
                <div className="mt-1 text-[11px] text-[var(--text3)]">SHA-256: <code className="break-all">{targetPkg.digestSha256}</code></div>
              </div>
            )}

            {progress && (
              <div className="text-[12px] text-[var(--text2)]">Tiến độ: {progress.done}/{progress.total} khóa</div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!targetPkg || status.kind === 'busy'}
                onClick={() => void handleRunImport()}
                className="h-10 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--onAccent)] hover:bg-[var(--accentStrong)] disabled:opacity-40"
              >
                {journal?.status === 'in_progress' ? 'Tiếp tục chuyển dữ liệu' : 'Bắt đầu chuyển dữ liệu'}
              </button>
              {status.kind === 'ok' && nativeMac && (
                <button
                  type="button"
                  onClick={() => void handleOpenMainApp()}
                  className="h-10 rounded-lg border border-[var(--accent)] px-4 text-[13px] font-medium text-[var(--accent)] hover:bg-[var(--hover)]"
                >
                  Mở OpenMindmap ngay
                </button>
              )}
            </div>
          </div>
        )}

        {status.text && (
          <div
            role="status"
            className={`mt-4 rounded-lg border p-3 text-[12.5px] ${
              status.kind === 'error'
                ? 'border-[var(--danger)] bg-[var(--dangerSoft)] text-[var(--danger)]'
                : status.kind === 'ok'
                  ? 'border-[var(--success)] bg-[var(--successSoft)] text-[var(--success)]'
                  : 'border-[var(--border)] bg-[var(--bg)] text-[var(--text)]'
            }`}
          >
            {status.text}
          </div>
        )}
      </div>
    </main>
  )
}
