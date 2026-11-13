export const WORKSPACE_TRANSFER_FORMAT = 'openmindmap-workspace-transfer' as const
export const WORKSPACE_TRANSFER_VERSION = 1 as const
export const EXPECTED_LOCAL_ORIGIN = 'http://127.0.0.1:41735'

export interface WorkspaceTransferEntry {
  key: string
  value: string
  sha256: string
  bytes: number
}

export interface WorkspaceTransferSummary {
  projects: number
  backups: number
  journals: number
  sessions: number
  trashCount: number
  totalEntries: number
  totalBytes: number
}

export interface WorkspaceTransferPackage {
  format: typeof WORKSPACE_TRANSFER_FORMAT
  version: typeof WORKSPACE_TRANSFER_VERSION
  origin: string
  createdAt: string
  sourceMode: 'browser-readonly'
  cleanShutdown: string | null
  summary: WorkspaceTransferSummary
  digestSha256: string
  entries: WorkspaceTransferEntry[]
}

export interface TransferJournalState {
  version: number
  transferId: string
  packageSha256: string
  status: 'in_progress' | 'completed' | 'rolled_back'
  startedAt: string
  updatedAt: string
  completedKeys: string[]
  keyDigests: Record<string, string>
  totalKeys: number
  lastError?: string | null
}

export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const EXACT_KEYS = new Set([
  'omm.registry.v3',
  'omm.settings.v3',
  'omm.trash.v3',
  'omm.cleanShutdown',
])

const KEY_PREFIXES = [
  'omm.project.',
  'omm.backup.',
  'omm.journal.',
  'omm.session.',
]

export function isTransferWorkspaceKey(key: string): boolean {
  if (EXACT_KEYS.has(key)) return true
  return KEY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)
}

function utf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

// Pure-JS SHA-256 fallback so hashing works even if crypto.subtle is absent in constrained test envs
function sha256Fallback(data: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const bitLen = data.length * 8
  const padLen = ((data.length + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(padLen)
  buf.set(data)
  buf[data.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  dv.setUint32(padLen - 4, bitLen >>> 0, false)
  const W = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  return H.map((n) => n.toString(16).padStart(8, '0')).join('')
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = utf8Bytes(text)
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return sha256Fallback(bytes)
}

function summarizeEntries(entries: WorkspaceTransferEntry[]): WorkspaceTransferSummary {
  let projects = 0
  let backups = 0
  let journals = 0
  let sessions = 0
  let trashCount = 0
  let totalBytes = 0
  for (const e of entries) {
    totalBytes += e.bytes
    if (e.key.startsWith('omm.project.')) projects++
    else if (e.key.startsWith('omm.backup.')) backups++
    else if (e.key.startsWith('omm.journal.')) journals++
    else if (e.key.startsWith('omm.session.')) sessions++
    else if (e.key === 'omm.trash.v3') {
      try {
        const parsed = JSON.parse(e.value)
        if (Array.isArray(parsed)) trashCount = parsed.length
      } catch { /* ignore */ }
    }
  }
  return { projects, backups, journals, sessions, trashCount, totalEntries: entries.length, totalBytes }
}

export async function computePackageDigest(
  origin: string,
  cleanShutdown: string | null,
  entries: WorkspaceTransferEntry[]
): Promise<string> {
  const ordered = [...entries].sort((a, b) => a.key.localeCompare(b.key))
  const lines = [
    WORKSPACE_TRANSFER_FORMAT,
    String(WORKSPACE_TRANSFER_VERSION),
    origin,
    cleanShutdown ?? 'null',
    ...ordered.map((e) => `${e.key}\t${e.bytes}\t${e.sha256}`),
  ]
  return sha256Hex(lines.join('\n'))
}

async function withOptionalWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      return await navigator.locks.request('omm.storage.write', { signal: controller.signal }, async () => {
        clearTimeout(timer)
        return await fn()
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return await fn()
}

export async function exportWorkspaceReadonly(
  storage: StorageLike = window.localStorage,
  origin = typeof window !== 'undefined' ? window.location.origin : EXPECTED_LOCAL_ORIGIN
): Promise<WorkspaceTransferPackage> {
  return withOptionalWriteLock(async () => {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k && k !== 'omm.cleanShutdown' && isTransferWorkspaceKey(k)) keys.push(k)
    }
    keys.sort((a, b) => a.localeCompare(b))
    const cleanShutdown = storage.getItem('omm.cleanShutdown')
    const entries: WorkspaceTransferEntry[] = []
    for (const key of keys) {
      const value = storage.getItem(key)
      if (value === null) continue
      entries.push({
        key,
        value,
        bytes: utf8Bytes(value).length,
        sha256: await sha256Hex(value),
      })
    }
    const summary = summarizeEntries(entries)
    const digestSha256 = await computePackageDigest(origin, cleanShutdown, entries)
    return {
      format: WORKSPACE_TRANSFER_FORMAT,
      version: WORKSPACE_TRANSFER_VERSION,
      origin,
      createdAt: new Date().toISOString(),
      sourceMode: 'browser-readonly',
      cleanShutdown,
      summary,
      digestSha256,
      entries,
    }
  })
}

export function listExistingWorkspaceKeys(storage: StorageLike): string[] {
  const out: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && isTransferWorkspaceKey(k)) out.push(k)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

export type TransferErrorCode =
  | 'invalid_format'
  | 'unsupported_version'
  | 'origin_mismatch'
  | 'invalid_key'
  | 'digest_mismatch'
  | 'non_empty_target'
  | 'already_completed'
  | 'mismatch_in_progress'
  | 'resume_integrity_failed'
  | 'write_verify_failed'
  | 'interrupted'
  | 'cancelled'

export async function validateTransferPackage(
  rawText: string,
  expectedOrigin = EXPECTED_LOCAL_ORIGIN
): Promise<{ ok: true; pkg: WorkspaceTransferPackage } | { ok: false; code: TransferErrorCode; message: string }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { ok: false, code: 'invalid_format', message: 'Tệp chuyển dữ liệu không phải JSON hợp lệ.' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, code: 'invalid_format', message: 'Cấu trúc gói chuyển dữ liệu không hợp lệ.' }
  }
  const obj = parsed as Partial<WorkspaceTransferPackage>
  if (obj.format !== WORKSPACE_TRANSFER_FORMAT) {
    return { ok: false, code: 'invalid_format', message: 'Tệp không đúng định dạng openmindmap-workspace-transfer.' }
  }
  if (obj.version !== WORKSPACE_TRANSFER_VERSION) {
    return { ok: false, code: 'unsupported_version', message: `Phiên bản gói không được hỗ trợ: ${String(obj.version)}.` }
  }
  if (obj.origin !== expectedOrigin) {
    return { ok: false, code: 'origin_mismatch', message: `Origin nguồn không khớp (${String(obj.origin)} !== ${expectedOrigin}).` }
  }
  if (!Array.isArray(obj.entries) || typeof obj.digestSha256 !== 'string') {
    return { ok: false, code: 'invalid_format', message: 'Thiếu entries hoặc digest SHA-256.' }
  }
  const seenKeys = new Set<string>()
  for (const entry of obj.entries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.bytes !== 'number') {
      return { ok: false, code: 'invalid_format', message: 'Mục dữ liệu trong gói không hợp lệ.' }
    }
    if (!isTransferWorkspaceKey(entry.key) || entry.key === 'omm.cleanShutdown' || seenKeys.has(entry.key)) {
      return { ok: false, code: 'invalid_key', message: `Khóa không hợp lệ hoặc trùng lặp: ${entry.key}` }
    }
    seenKeys.add(entry.key)
    const actualBytes = utf8Bytes(entry.value).length
    const actualHash = await sha256Hex(entry.value)
    if (actualBytes !== entry.bytes || actualHash !== entry.sha256) {
      return { ok: false, code: 'digest_mismatch', message: `Sai lệch chữ ký SHA-256 tại khóa ${entry.key}. Gói dữ liệu đã bị hỏng hoặc chỉnh sửa.` }
    }
  }
  const cleanShutdown = obj.cleanShutdown === undefined ? null : obj.cleanShutdown
  if (cleanShutdown !== null && typeof cleanShutdown !== 'string') {
    return { ok: false, code: 'invalid_format', message: 'Trường cleanShutdown không hợp lệ.' }
  }
  const expectedDigest = await computePackageDigest(obj.origin, cleanShutdown, obj.entries)
  if (expectedDigest !== obj.digestSha256) {
    return { ok: false, code: 'digest_mismatch', message: 'Sai lệch chữ ký tổng thể SHA-256 của gói chuyển dữ liệu.' }
  }
  return { ok: true, pkg: { ...obj, cleanShutdown } as WorkspaceTransferPackage }
}

export interface TransferJournalHooks {
  beginOrResume: (packageSha256: string, totalKeys: number) => Promise<{ ok: true; mode: 'start' | 'resume'; journal: TransferJournalState } | { ok: false; code?: string; error: string }>
  markKey: (key: string, sha256: string) => Promise<{ ok: true } | { ok: false; error: string }>
  complete: () => Promise<{ ok: true } | { ok: false; error: string }>
  rollback: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

function writePriority(key: string): number {
  if (key.startsWith('omm.project.')) return 1
  if (key.startsWith('omm.backup.')) return 2
  if (key.startsWith('omm.journal.')) return 3
  if (key.startsWith('omm.session.')) return 4
  if (key === 'omm.trash.v3') return 5
  if (key === 'omm.settings.v3') return 6
  if (key === 'omm.registry.v3') return 7
  return 8
}

export interface ImportTransferResult {
  ok: boolean
  code?: TransferErrorCode
  message: string
  writtenKeys: number
  resumedFromKeys: number
  rolledBackKeys?: number
}

export async function importWorkspaceTransactional(
  pkg: WorkspaceTransferPackage,
  storage: StorageLike,
  journal: TransferJournalHooks,
  options: {
    onProgress?: (done: number, total: number, currentKey: string) => void
    shouldAbortBeforeKey?: (key: string, writtenInRun: number) => 'interrupt' | 'cancel' | false
  } = {}
): Promise<ImportTransferResult> {
  return withOptionalWriteLock(async () => {
    const startRes = await journal.beginOrResume(pkg.digestSha256, pkg.entries.length)
    if (!startRes.ok) {
      const code = (startRes.code === 'already_completed' || startRes.code === 'mismatch_in_progress')
        ? startRes.code
        : 'invalid_format'
      return { ok: false, code, message: startRes.error, writtenKeys: 0, resumedFromKeys: 0 }
    }

    const existingKeys = listExistingWorkspaceKeys(storage)
    const entryMap = new Map(pkg.entries.map((e) => [e.key, e]))
    const alreadyDone = new Set<string>(startRes.journal.completedKeys)

    if (startRes.mode === 'start') {
      if (existingKeys.length > 0) {
        await journal.rollback('target_non_empty')
        return {
          ok: false,
          code: 'non_empty_target',
          message: `Ứng dụng đích đã có ${existingKeys.length} khóa dữ liệu (${existingKeys.slice(0, 3).join(', ')}…). Từ chối ghi đè âm thầm.`,
          writtenKeys: 0,
          resumedFromKeys: 0,
        }
      }
    } else {
      // Resume mode: verify every previously completed key still matches package SHA-256
      for (const doneKey of alreadyDone) {
        const expected = entryMap.get(doneKey)
        const current = storage.getItem(doneKey)
        if (!expected || current === null || (await sha256Hex(current)) !== expected.sha256) {
          return {
            ok: false,
            code: 'resume_integrity_failed',
            message: `Dữ liệu đã ghi trước đó tại khóa ${doneKey} bị thay đổi hoặc thiếu; không thể tiếp tục tự động.`,
            writtenKeys: 0,
            resumedFromKeys: 0,
          }
        }
      }
      for (const curKey of existingKeys) {
        if (curKey !== 'omm.cleanShutdown' && !alreadyDone.has(curKey)) {
          return {
            ok: false,
            code: 'non_empty_target',
            message: `Phát hiện khóa ngoài phiên chuyển (${curKey}) trên máy đích.`,
            writtenKeys: 0,
            resumedFromKeys: 0,
          }
        }
      }
    }

    const ordered = [...pkg.entries].sort((a, b) => writePriority(a.key) - writePriority(b.key) || a.key.localeCompare(b.key))
    const writtenSnapshots = new Map<string, string>()

    const performRollback = async (reason: string): Promise<number> => {
      let removed = 0
      const candidates = new Set([...alreadyDone, ...writtenSnapshots.keys()])
      for (const key of candidates) {
        const expected = writtenSnapshots.get(key) ?? entryMap.get(key)?.value
        if (expected !== undefined && storage.getItem(key) === expected) {
          storage.removeItem(key)
          removed++
        }
      }
      if (storage.getItem('omm.cleanShutdown') === pkg.cleanShutdown && pkg.cleanShutdown !== null) {
        storage.removeItem('omm.cleanShutdown')
      }
      await journal.rollback(reason)
      return removed
    }

    let writtenInRun = 0
    for (let i = 0; i < ordered.length; i++) {
      const entry = ordered[i]
      if (alreadyDone.has(entry.key)) continue

      const abortReason = options.shouldAbortBeforeKey?.(entry.key, writtenInRun)
      if (abortReason === 'interrupt') {
        return {
          ok: false,
          code: 'interrupted',
          message: `Phiên chuyển dữ liệu tạm dừng trước khóa ${entry.key} (giữ journal để tiếp tục).`,
          writtenKeys: writtenInRun,
          resumedFromKeys: alreadyDone.size,
        }
      }
      if (abortReason === 'cancel') {
        const removed = await performRollback('user_cancelled')
        return {
          ok: false,
          code: 'cancelled',
          message: 'Đã hủy chuyển dữ liệu và hoàn tác sạch các khóa đã ghi.',
          writtenKeys: 0,
          resumedFromKeys: 0,
          rolledBackKeys: removed,
        }
      }

      try {
        storage.setItem(entry.key, entry.value)
        const readBack = storage.getItem(entry.key)
        if (readBack !== entry.value || (await sha256Hex(readBack)) !== entry.sha256) {
          throw new Error(`Xác minh đọc lại thất bại tại ${entry.key}`)
        }
        writtenSnapshots.set(entry.key, entry.value)
        const mark = await journal.markKey(entry.key, entry.sha256)
        if (!mark.ok) throw new Error(mark.error)
        writtenInRun++
        options.onProgress?.(alreadyDone.size + writtenInRun, ordered.length, entry.key)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const removed = await performRollback(msg)
        return {
          ok: false,
          code: 'write_verify_failed',
          message: `Chuyển dữ liệu thất bại và đã hoàn tác (${msg}).`,
          writtenKeys: 0,
          resumedFromKeys: 0,
          rolledBackKeys: removed,
        }
      }
    }

    // Preserve exact cleanShutdown flag ('1' or absent) only after every data key verified
    if (pkg.cleanShutdown !== null) {
      storage.setItem('omm.cleanShutdown', pkg.cleanShutdown)
      if (storage.getItem('omm.cleanShutdown') !== pkg.cleanShutdown) {
        const removed = await performRollback('cleanShutdown_verify_failed')
        return {
          ok: false,
          code: 'write_verify_failed',
          message: 'Không xác minh được cờ cleanShutdown; đã hoàn tác.',
          writtenKeys: 0,
          resumedFromKeys: 0,
          rolledBackKeys: removed,
        }
      }
    } else {
      storage.removeItem('omm.cleanShutdown')
    }

    const doneRes = await journal.complete()
    if (!doneRes.ok) {
      return {
        ok: false,
        code: 'write_verify_failed',
        message: `Dữ liệu đã ghi nhưng không hoàn tất được journal: ${doneRes.error}`,
        writtenKeys: writtenInRun,
        resumedFromKeys: alreadyDone.size,
      }
    }

    return {
      ok: true,
      message: `Đã chuyển và xác minh ${ordered.length} khóa dữ liệu sang OpenMindmap macOS.`,
      writtenKeys: writtenInRun,
      resumedFromKeys: alreadyDone.size,
    }
  })
}
