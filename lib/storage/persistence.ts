import { ProjectDocV3 } from '../core/types'
import { loadRegistry, metaFromDoc, upsertMeta, saveProjectAtomic, loadSettings, saveSettings, pushBackup, readStoredProject, trashList, STORAGE_KEYS } from './projects'

export type WriteResult =
  | { kind: 'saved'; raw: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string; writtenRaw?: string }

export type NativeCollisionCheck =
  | { kind: 'free' }
  | { kind: 'equivalent'; raw: string; doc: ProjectDocV3 }
  | { kind: 'collision'; reason: 'different_content' | 'in_trash' | 'orphan_metadata' | 'unreadable_target' | 'unregistered_target'; message: string }

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonicalizeValue(v)
    }
    return out
  }
  return value
}

export function sameCanonicalProject(a: ProjectDocV3, b: ProjectDocV3, ignoreUpdatedAt = false): boolean {
  const norm = (d: ProjectDocV3) => {
    const copy: Record<string, unknown> = { ...d, version_note: d.version_note ?? null }
    if (ignoreUpdatedAt) delete copy.updated_at
    return JSON.stringify(canonicalizeValue(copy))
  }
  return norm(a) === norm(b)
}

export function inspectNativeImportId(doc: ProjectDocV3, options: { ignoreUpdatedAt?: boolean } = {}): NativeCollisionCheck {
  if (trashList().some((item) => item.id === doc.project_id)) {
    return {
      kind: 'collision',
      reason: 'in_trash',
      message: 'ID dự án đang nằm trong Thùng rác. Hãy chọn "Nhập thành dự án mới (remap ID)" hoặc khôi phục từ Thùng rác.',
    }
  }
  const raw = projectRaw(doc.project_id)
  if (raw === null) {
    if (loadRegistry().some((m) => m.id === doc.project_id)) {
      return {
        kind: 'collision',
        reason: 'orphan_metadata',
        message: 'Tìm thấy metadata dự án mồ côi cho project_id này nhưng thiếu dữ liệu gốc. Hãy chọn "Nhập thành dự án mới (remap ID)".',
      }
    }
    return { kind: 'free' }
  }
  const stored = readStoredProject(raw, doc.project_id)
  if (!stored) {
    return {
      kind: 'collision',
      reason: 'unreadable_target',
      message: 'Dữ liệu dự án hiện có cùng project_id không đọc được. Từ chối ghi đè; hãy chọn "Nhập thành dự án mới (remap ID)".',
    }
  }
  if (!loadRegistry().some((m) => m.id === doc.project_id)) {
    return {
      kind: 'collision',
      reason: 'unregistered_target',
      message: 'Đã tồn tại dữ liệu nháp/chưa hoàn tất metadata cho project_id này từ một tác vụ khác. Không thể kế thừa quyền ghi; hãy chọn "Nhập thành dự án mới (remap ID)".',
    }
  }
  if (sameCanonicalProject(doc, stored, options.ignoreUpdatedAt)) {
    return { kind: 'equivalent', raw, doc: stored }
  }
  return {
    kind: 'collision',
    reason: 'different_content',
    message: `Đã tồn tại dự án "${stored.name}" có cùng project_id nhưng khác nội dung. Không thể ghi đè; hãy chọn "Nhập thành dự án mới (remap ID)".`,
  }
}

export function projectRaw(id: string): string | null {
  return localStorage.getItem(STORAGE_KEYS.project(id))
}

export async function withStorageWrite<T>(write: () => T | Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Môi trường không hỗ trợ khóa ghi an toàn. Hãy dùng localhost/HTTPS và trình duyệt hỗ trợ Web Locks; nội dung vẫn có thể Xuất.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    // ponytail: one origin-wide lock also protects registry read/modify/write.
    return await navigator.locks.request('omm.storage.write', { signal: controller.signal }, async () => {
      clearTimeout(timer)
      return await write()
    })
  } catch (e) {
    if (controller.signal.aborted) throw new Error('Hết thời gian chờ khóa ghi (5 giây). Hãy thử lại.')
    throw e
  } finally { clearTimeout(timer) }
}

function writeAndVerifyMetadata(doc: ProjectDocV3, activate: boolean, setStage: (s: string) => void) {
  setStage('cập nhật danh sách dự án')
  const expectedMeta = metaFromDoc(doc, loadRegistry().find(m => m.id === doc.project_id))
  upsertMeta(expectedMeta)
  const meta = loadRegistry().find(m => m.id === doc.project_id)
  if (JSON.stringify(meta) !== JSON.stringify(expectedMeta)) throw new Error('Xác thực danh sách dự án thất bại')
  if (activate) {
    setStage('lưu dự án mở gần nhất')
    const settings = { ...loadSettings(), lastProjectId: doc.project_id }
    saveSettings(settings)
    if (JSON.stringify(loadSettings()) !== JSON.stringify(settings)) throw new Error('Xác thực dự án mở gần nhất thất bại')
  }
}

export type NativeOpenResult =
  | { kind: 'saved'; doc: ProjectDocV3; raw: string }
  | { kind: 'conflict'; message: string; dropVerified?: boolean }
  | { kind: 'error'; message: string; verifiedRaw?: string }

/** Commit native JSON import under Web Lock: never overwrites different content for an existing ID. */
export async function commitNativeOpen(
  doc: ProjectDocV3,
  options: { verifiedRaw?: string; ignoreUpdatedAt?: boolean } = {},
): Promise<NativeOpenResult> {
  let verifiedRaw = options.verifiedRaw
  let stage = 'lấy khóa ghi'
  try {
    return await withStorageWrite(() => {
      if (verifiedRaw !== undefined) {
        stage = 'xác minh lại bản đã ghi'
        const current = projectRaw(doc.project_id)
        const inTrash = trashList().some((item) => item.id === doc.project_id)
        if (inTrash || current !== verifiedRaw) {
          return {
            kind: 'conflict' as const,
            dropVerified: true,
            message: 'Dự án đã bị thay đổi hoặc xóa ở tab khác trước khi hoàn tất metadata.',
          }
        }
        const stored = readStoredProject(verifiedRaw, doc.project_id)
        if (!stored) {
          return { kind: 'conflict' as const, dropVerified: true, message: 'Dữ liệu dự án đã lưu không còn hợp lệ.' }
        }
        writeAndVerifyMetadata(stored, true, (s) => { stage = s })
        return { kind: 'saved' as const, doc: stored, raw: verifiedRaw }
      }
      stage = 'kiểm tra xung đột project_id'
      const check = inspectNativeImportId(doc, { ignoreUpdatedAt: options.ignoreUpdatedAt })
      if (check.kind === 'collision') {
        return { kind: 'conflict' as const, message: check.message }
      }
      if (check.kind === 'equivalent') {
        writeAndVerifyMetadata(check.doc, true, (s) => { stage = s })
        return { kind: 'saved' as const, doc: check.doc, raw: check.raw }
      }
      stage = 'ghi và xác thực dự án'
      const raw = JSON.stringify(doc)
      const result = saveProjectAtomic(doc)
      if (!result.ok) throw new Error(result.error)
      if (projectRaw(doc.project_id) !== raw) throw new Error('Dữ liệu đọc lại không khớp bản ứng viên')
      verifiedRaw = raw
      writeAndVerifyMetadata(doc, true, (s) => { stage = s })
      return { kind: 'saved' as const, doc, raw }
    })
  } catch (e) {
    return { kind: 'error', message: `Không thể ${stage}: ${e instanceof Error ? e.message : String(e)}`, verifiedRaw }
  }
}

/** Caller retains writtenRaw even when a subsequent metadata write fails. */
export async function persistProject(doc: ProjectDocV3, expected: string | null, options: { activate?: boolean; backupCount?: number } = {}): Promise<WriteResult> {
  let writtenRaw: string | undefined
  let stage = 'lấy khóa ghi'
  try {
    return await withStorageWrite(() => {
      stage = 'kiểm tra bản nền'
      const raw = JSON.stringify(doc)
      const current = projectRaw(doc.project_id)
      if (current !== expected && current !== raw) return { kind: 'conflict' as const, message: 'Dự án đã bị thay đổi hoặc xóa ở tab khác. Hãy Tải lại hoặc Lưu thành.' }
      if (raw !== current) {
        if (options.backupCount !== undefined) pushBackup(doc, options.backupCount)
        stage = 'ghi và xác thực dự án'
        const result = saveProjectAtomic(doc)
        if (!result.ok) throw new Error(result.error)
      }
      writtenRaw = raw
      writeAndVerifyMetadata(doc, !!options.activate, (s) => { stage = s })
      return { kind: 'saved' as const, raw }
    })
  } catch (e) {
    return { kind: 'error', message: `Không thể ${stage}: ${e instanceof Error ? e.message : String(e)}`, writtenRaw }
  }
}
