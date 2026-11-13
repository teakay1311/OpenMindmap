/* ============================================================
 * OpenMindmap — components/dialogs.tsx
 * Nhập (14.1), Xuất (14.2 + stale + outlier), Cài đặt 5 nhóm (15),
 * Recovery (17.3/13.2), Xác nhận, Phím tắt, Giới thiệu, Hướng dẫn.
 * ============================================================ */
'use client'
import DOMPurify from 'dompurify'
import { decodeEmbeddedBitmap } from '../lib/io/images'
import { inspectNativeImportId } from '../lib/storage/persistence'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../lib/store'
import {
  buildImportPreview, ImportPreview, outlineToTopics, remapProject, detectFormat, assertImportSize,
} from '../lib/io/importers'
import {
  ExportOptions, analyzeExport, exportJSON, exportMarkdown, exportOPML, exportTXT,
  exportSVG, exportPDF, estimatePNG, planPdfMultipage, download, sanitizeFileName, canvasToBlob, LOSS_REPORT_TEXT,
  exportScopeError,
} from '../lib/io/exporters'
import { sceneToSVG } from '../lib/scene/scene'
import { ProjectDocV3, newProjectDoc, newTopic, getTheme, PROJECT_THEMES, uuid, LIMITS } from '../lib/core/types'
import { getTopic, descendantsOf } from '../lib/core/tree'
import { defaultSettings, trashList, TrashItem } from '../lib/storage/projects'
import { IconBtn, Field, Row, NumberInput, ToggleField, SelectField, Segmented, TextInput } from './ui-bits'
import { CloseIcon } from './ui-icons'

/* ================= shell chung ================= */
function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const projectBusy = useApp(s => s.transitionBusy)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (useApp.getState().transitionBusy) return
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (dialogs[dialogs.length - 1] !== dialogRef.current || e.defaultPrevented || e.isComposing) return
      if (e.key === 'Escape' && !(dialogRef.current?.contains(e.target as Node) && (e.target as HTMLElement)?.matches('input,textarea,[contenteditable="true"]'))) { e.preventDefault(); e.stopImmediatePropagation(); onClose() }
      if (e.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length)
        const index = controls.indexOf(document.activeElement as HTMLElement)
        if (controls.length && (index < 0 || e.shiftKey && index === 0 || !e.shiftKey && index === controls.length - 1)) { e.preventDefault(); controls[e.shiftKey ? controls.length - 1 : 0].focus() }
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 omm-fade-in" onPointerDown={(e) => { if (!projectBusy && e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} inert={projectBusy} role="dialog" aria-modal="true" aria-label={title} className={`flex max-h-[calc(100dvh-32px)] w-full ${wide ? 'max-w-[1080px]' : 'max-w-[640px]'} flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]`} style={{ boxShadow: 'var(--shadow-pop)' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{title}</h2>
          <button type="button" disabled={projectBusy} onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]" aria-label="Đóng">
            <CloseIcon size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--panel-2-bg)] px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  )
}

/* ================= Nhập (14.1) ================= */
export function ImportDialog() {
  const open = useApp((s) => s.importOpen)
  const setImportOpen = useApp((s) => s.setImportOpen)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [spaceWidth, setSpaceWidth] = useState<2 | 4 | null>(null)
  const [jsonMode, setJsonMode] = useState<'open' | 'new'>('new')
  const fileRef = useRef<HTMLInputElement>(null)
  const importContent = useRef<string | null>(null)
  const readSequence = useRef(0)
  const importTaskId = useRef<string>(uuid())
  const [importBusy, setImportBusy] = useState(false)
  const resetImport = () => {
    readSequence.current++
    importTaskId.current = uuid()
    importContent.current = null
    setPreview(null)
    setError(null)
    setCommitError(null)
    setNameEdited(false)
  }
  const closeImport = () => { if (!importBusy) { resetImport(); setImportOpen(false) } }
  useEffect(() => { if (!open) resetImport() }, [open])

  function loadFile(file: File) {
    if (importBusy) return
    setError(null)
    setCommitError(null)
    setPreview(null)
    setNameEdited(false)
    importTaskId.current = uuid()
    const sequence = ++readSequence.current
    importContent.current = null
    const run = async () => {
      try {
        let format = detectFormat(file.name, '')
        assertImportSize(file.size, format)
        if (!format) {
          const prefix = await file.slice(0, 2000).text()
          if (sequence !== readSequence.current) return
          format = detectFormat(file.name, prefix)
          if (!format) throw new Error('Định dạng không hỗ trợ. Chỉ nhập được .mindmap.json / .json / .md / .opml / .txt')
          assertImportSize(file.size, format)
        }
        const content = await file.text()
        if (sequence !== readSequence.current) return
        importContent.current = content
        const p = buildImportPreview(file.name, content, spaceWidth)
        for (const asset of p.nativeDoc?.assets ?? []) {
          if (sequence !== readSequence.current) return
          const { width, height } = await decodeEmbeddedBitmap(asset.data_url)
          if (width !== asset.width || height !== asset.height) throw new Error('Kích thước ảnh nhúng không khớp dữ liệu.')
        }
        if (sequence !== readSequence.current) return
        setPreview(p)
        setName(p.suggestedName)
        setJsonMode('new')
      } catch (e) {
        if (sequence === readSequence.current) setError(e instanceof Error ? e.message : 'Không đọc được tệp')
      }
    }
    void run()
  }

  useEffect(() => {
    const onFile = (e: Event) => {
      const file = (e as CustomEvent).detail as File
      void loadFile(file)
    }
    window.addEventListener('omm-import-file', onFile)
    return () => window.removeEventListener('omm-import-file', onFile)
     
  }, [importBusy, spaceWidth])

  const reparseWithSpace = (sw: 2 | 4) => {
    setSpaceWidth(sw)
    if (!preview || preview.format !== 'txt') return
    // Reparse the selected file from RAM; storage quota must not block preview.
    const cached = importContent.current
    if (cached) {
      try {
        const p = buildImportPreview(preview.fileName, cached, sw)
        setPreview(p)
      } catch (e) { setError(e instanceof Error ? e.message : 'Lỗi') }
    }
  }

  const nativeCollision = useMemo(() => {
    if (!preview?.nativeDoc || jsonMode !== 'open') return null
    try {
      const candidate = { ...preview.nativeDoc, name: name || preview.nativeDoc.name }
      return inspectNativeImportId(candidate, { ignoreUpdatedAt: preview.synthesizedUpdatedAt })
    } catch (e) {
      return { kind: 'collision' as const, reason: 'unreadable_target' as const, message: e instanceof Error ? e.message : 'Không kiểm tra được dữ liệu lưu trữ' }
    }
  }, [preview, jsonMode, name])

  if (!open) return null
  return (
    <Modal title="Nhập dự án" onClose={closeImport}
      footer={
        <>
          <button onClick={closeImport} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--text)] transition-all hover:border-[var(--border-strong)] hover:bg-[var(--hover)]">Hủy</button>
          <button
            disabled={!preview || importBusy || preview.nodeCount === 0 || (jsonMode === 'open' && nativeCollision?.kind === 'collision')}
            onClick={async () => {
              if (!preview || importBusy) return
              if (preview.nodeCount === 0) { setError('Tệp không có chủ đề nào để nhập.'); return }
              setCommitError(null)
              setImportBusy(true)
              const st = useApp.getState()
              try {
                let ok = false
                if (preview.nativeDoc && jsonMode === 'open') {
                  const candidate = { ...preview.nativeDoc, name: name || preview.nativeDoc.name }
                  ok = await st.openNativeDoc(candidate, { taskId: importTaskId.current, ignoreUpdatedAt: preview.synthesizedUpdatedAt })
                  if (!ok) setCommitError('Không thể mở dự án giữ nguyên ID (có xung đột hoặc lỗi lưu). Hãy kiểm tra thông báo hoặc chọn "Nhập thành dự án mới (remap ID)".')
                } else if (preview.nativeDoc) {
                  ok = await st.importOutline({ ...remapProject(preview.nativeDoc), name: name || preview.suggestedName })
                  if (!ok) setCommitError('Tạo dự án mới từ JSON thất bại.')
                } else {
                  const { topics, centralId } = outlineToTopics(preview.roots)
                  const base = newProjectDoc(name || preview.suggestedName)
                  const doc: ProjectDocV3 = {
                    ...base,
                    central_topic_id: centralId,
                    topics,
                  }
                  const central = doc.topics.find((t) => t.id === doc.central_topic_id)
                  if (!central) throw new Error('Tệp không có chủ đề trung tâm để tạo dự án.')
                  ok = await st.importOutline(doc)
                }
                if (ok) { resetImport(); setImportOpen(false) }
              } catch (e) {
                st.toast('error', 'Tạo dự án thất bại', e instanceof Error ? e.message : '')
              } finally { setImportBusy(false) }
            }}
            className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {preview?.nativeDoc && jsonMode === 'open' ? 'Mở dự án' : 'Tạo dự án'}
          </button>
        </>
      }
    >
      {!preview && !error && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault()
            const f = e.dataTransfer.files?.[0]
            if (f) await loadFile(f)
          }}
          className="flex h-56 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[var(--border)] text-center"
        >
          <div className="text-[13px] text-[var(--text)]">Kéo tệp vào đây hoặc</div>
          <button type="button" onClick={() => fileRef.current?.click()} className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--onAccent)] hover:bg-[var(--accentStrong)]">Chọn tệp…</button>
          <div className="text-[11.5px] text-[var(--text2)]">JSON (.mindmap.json/.json): tối đa {LIMITS.jsonBytes / (1024 * 1024)} MiB · MD/OPML/TXT: tối đa {LIMITS.textBytes / (1024 * 1024)} MiB</div>
          <input ref={fileRef} type="file" accept=".json,.mindmap.json,.md,.markdown,.opml,.txt" className="hidden"
            onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-[var(--danger)] bg-[var(--dangerSoft)] p-3 text-[12.5px] text-[var(--danger)]">
          {error}
          <button type="button" onClick={() => { setError(null); setPreview(null) }} className="ml-3 underline">Thử tệp khác</button>
        </div>
      )}
      {preview && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Tên dự án">
              <TextInput value={name} onChange={(e) => { setName(e.target.value); setNameEdited(true); setCommitError(null); importTaskId.current = uuid() }} className="h-9 bg-[var(--bg)] text-[13px]" />
            </Field>
            <div className="grid grid-cols-4 gap-2 pt-1 text-center text-[11px]">
              <Stat label="Node" v={preview.nodeCount} />
              <Stat label="Độ sâu" v={preview.maxDepth} />
              <Stat label="Ghi chú" v={preview.noteCount} />
              <Stat label="Checkbox" v={preview.checkboxCount} />
            </div>
          </div>
          {preview.nativeDoc && (
            <Field label="Cách nhập JSON native">
              <Row className="gap-2">
                <label className="flex items-center gap-1.5 text-[12.5px]"><input type="radio" checked={jsonMode === 'new'} onChange={() => { setJsonMode('new'); setCommitError(null); importTaskId.current = uuid(); if (!nameEdited) setName(preview.suggestedName) }} /> Nhập thành dự án mới (remap ID)</label>
                <label className="flex items-center gap-1.5 text-[12.5px]"><input type="radio" checked={jsonMode === 'open'} onChange={() => { setJsonMode('open'); setCommitError(null); importTaskId.current = uuid(); if (!nameEdited && preview.nativeDoc) setName(preview.nativeDoc.name) }} /> Mở (giữ project_id)</label>
              </Row>
            </Field>
          )}
          {jsonMode === 'open' && nativeCollision?.kind === 'collision' && (
            <div role="alert" className="rounded-lg border border-[var(--danger)] bg-[var(--danger)]/5 p-2.5 text-[12px] text-[var(--danger)]">
              <div>{nativeCollision.message}</div>
              <button type="button" onClick={() => { setJsonMode('new'); setCommitError(null); importTaskId.current = uuid() }} className="mt-1.5 rounded border border-[var(--danger)] px-2.5 py-1 text-[11.5px] font-medium hover:bg-[var(--danger)]/10">
                Nhập thành dự án mới
              </button>
            </div>
          )}
          {commitError && (
            <div role="alert" className="rounded-lg border border-[var(--danger)] bg-[var(--danger)]/5 p-2.5 text-[12px] text-[var(--danger)]">
              <div>{commitError}</div>
              {preview.nativeDoc && jsonMode === 'open' && (
                <button type="button" onClick={() => { setJsonMode('new'); setCommitError(null); importTaskId.current = uuid() }} className="mt-1.5 rounded border border-[var(--danger)] px-2.5 py-1 text-[11.5px] font-medium hover:bg-[var(--danger)]/10">
                  Nhập thành dự án mới
                </button>
              )}
            </div>
          )}
          {preview.format === 'txt' && preview.spaceWidth !== null && (
            <Field label="Tệp TXT dùng khoảng trắng — chọn chuẩn thụt">
              <Segmented value={String(preview.spaceWidth)} options={[{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }]} onChange={(v) => reparseWithSpace(Number(v) as 2 | 4)} />
            </Field>
          )}
          {preview.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-400 bg-amber-400/5 p-2.5 text-[12px]">
              <div className="mb-1 font-medium">Cảnh báo / Migration</div>
              <ul className="list-disc pl-4 text-[var(--text2)]">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2-bg)] p-2.5">
            <div className="mb-1.5 text-[11.5px] font-medium text-[var(--text2)]">Cây xem trước</div>
            <div data-import-outline-tree className="max-h-48 overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 text-[12.5px]">
              {preview.roots.slice(0, 40).map((r, i) => <OutlineRow key={i} node={r} depth={0} />)}
            </div>
          </div>
          {preview.lossReport.length > 0 && (
            <div className="text-[11.5px] text-[var(--text2)]">
              <span className="font-medium">Báo cáo mất dữ liệu: </span>{preview.lossReport.join(' ')}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
function Stat({ label, v }: { label: string; v: number }) {
  return <div className="rounded-lg border border-[var(--border)] py-1.5"><div className="text-[15px] font-semibold tabular-nums">{v}</div><div className="text-[10px] text-[var(--text2)]">{label}</div></div>
}
function OutlineRow({ node, depth }: { node: ImportPreview['roots'][number]; depth: number }) {
  const extra = node.children.length - 3
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 whitespace-nowrap py-0.5 leading-snug" style={{ paddingLeft: depth * 14 }}>
        {depth > 0 && <span className="select-none text-[var(--text3)]" aria-hidden="true">└</span>}
        <span className={depth === 0 ? 'font-medium text-[var(--text)]' : 'text-[var(--text2)]'}>
          {node.checked === true ? '☑ ' : node.checked === false ? '☐ ' : ''}{node.text || '(rỗng)'}
        </span>
      </div>
      {node.children.slice(0, 3).map((c, i) => <OutlineRow key={i} node={c} depth={depth + 1} />)}
      {extra > 0 && (
        <div className="py-0.5 text-[10.5px] text-[var(--text3)]" style={{ paddingLeft: (depth + 1) * 14 }}>
          …+{extra} nhánh con
        </div>
      )}
    </div>
  )
}

/* ================= Xuất (14.2) ================= */
const defaultExportOptions = (doc: ProjectDocV3): ExportOptions => ({
  format: 'png',
  scope: 'entire',
  scopeRootId: null,
  visibility: 'includeCollapsed',
  includeDrawings: true,
  excludedDrawingIds: [],
  background: 'canvas',
  autoFit: true,
  paddingPercent: 'auto',
  pngScale: 2,
  pdfPaper: 'content',
  pdfOrientation: 'landscape',
  pdfMode: 'onepage',
  fileName: sanitizeFileName(doc.name),
})

export function ExportDialog() {
  const state = useApp((s) => s.exportOpen)
  const doc = useApp((s) => s.doc)
  const [opts, setOpts] = useState<ExportOptions | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (state?.open && doc) {
      setOpts({ ...defaultExportOptions(doc), scopeRootId: state.scopeRootId ?? null, scope: state.scopeRootId ? 'branch' : 'entire' })
      setStale(false)
    }
     
  }, [state?.open])

  useEffect(() => {
    if (state?.open && doc && opts) setStale(true)
     
  }, [doc?.document_revision])

  const scopeError = useMemo(() => (doc && opts ? exportScopeError(doc, opts) : null), [doc, opts])
  const analysisState = useMemo(() => {
    if (!doc || !opts) return { analysis: null as ReturnType<typeof analyzeExport> | null, error: null as string | null }
    if (scopeError) return { analysis: null, error: scopeError }
    try {
      return { analysis: analyzeExport(doc, opts), error: null as string | null }
    } catch (e) {
      return { analysis: null, error: e instanceof Error ? e.message : 'Không dựng được bản xem trước' }
    }
  }, [doc, opts, scopeError])
  const analysis = analysisState.analysis
  const analysisError = analysisState.error

  if (!state?.open || !doc || !opts) return null
  const close = () => { useApp.getState().closeExport(); setOpts(null) }
  const upd = (patch: Partial<ExportOptions>) => setOpts({ ...opts, ...patch })

  const isImage = opts.format === 'png' || opts.format === 'svg' || opts.format === 'pdf'
  const est = analysis && opts.format === 'png' ? estimatePNG(analysis.scene, analysis.padding, opts.pngScale) : null
  const pdfPlan = analysis && opts.format === 'pdf' && opts.pdfPaper !== 'content' && opts.pdfMode === 'multipage'
    ? planPdfMultipage(analysis.scene, opts, analysis.padding)
    : null

  const doExport = async () => {
    if (!analysis || analysisError || busy || stale) return
    if (opts.format === 'png' && est?.exceedsLimit) return
    if (opts.format === 'pdf' && pdfPlan && !pdfPlan.ok) return
    setBusy(true)
    try {
      const st = useApp.getState()
      if (st.doc !== doc || st.exportOpen !== state) throw new Error('Dự án đã thay đổi. Hãy mở lại hộp thoại Xuất.')
      // One immutable snapshot for validation + all export formats.
      const snapshot = structuredClone(doc)
      const fresh = analyzeExport(snapshot, opts)
      const ext = { json: 'mindmap.json', md: 'md', opml: 'opml', txt: 'txt', png: 'png', svg: 'svg', pdf: 'pdf' }[opts.format]
      const fileName = `${opts.fileName || sanitizeFileName(snapshot.name)}.${ext}`
      const stillSameProject = () => {
        const live = useApp.getState()
        if (live.doc !== doc || live.generation !== st.generation || live.exportOpen !== state) throw new Error('Phiên xuất đã thay đổi. Hãy mở lại hộp thoại Xuất.')
      }
      if (opts.format === 'json') {
        download(exportJSON(snapshot, opts), fileName)
      } else if (opts.format === 'md') {
        download(exportMarkdown(snapshot, opts), fileName)
      } else if (opts.format === 'opml') {
        download(exportOPML(snapshot, opts), fileName)
      } else if (opts.format === 'txt') {
        download(exportTXT(snapshot, opts), fileName)
      } else if (opts.format === 'svg') {
        download(exportSVG(fresh.scene, opts, fresh.padding), fileName)
      } else if (opts.format === 'png') {
        const { rasterizeSVG } = await import('../lib/io/exporters')
        const svg = exportSVG(fresh.scene, opts, fresh.padding)
        const fillBg = opts.background === 'canvas' ? fresh.scene.canvasBg : opts.background === 'white' ? '#FFFFFF' : true
        const canvas = await rasterizeSVG(svg, opts.pngScale, fillBg)
        const blob = await canvasToBlob(canvas)
        stillSameProject()
        download(blob, fileName)
      } else if (opts.format === 'pdf') {
        const blob = await exportPDF(fresh.scene, opts, fresh.padding)
        stillSameProject()
        download(blob, fileName)
      }
      st.toast('success', 'Đã xuất tệp', fileName)
      close()
    } catch (e) {
      useApp.getState().toast('error', 'Xuất thất bại', e instanceof Error ? e.message : '')
    } finally {
      setBusy(false)
    }
  }

  let svgPreview: string | null = null
  if (analysis && isImage) {
    try {
      svgPreview = DOMPurify.sanitize(sceneToSVG(analysis.scene, {
        background: opts.background === 'canvas' ? ('canvas' as never) : opts.background,
        padding: analysis.padding,
        includeUI: false,
      }), {
        ALLOWED_TAGS: ['svg', 'g', 'path', 'rect', 'circle', 'text', 'tspan', 'image', 'defs', 'clipPath'],
        ALLOWED_ATTR: ['xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height', 'x', 'y', 'd', 'cx', 'cy', 'r', 'rx', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'text-decoration', 'preserveAspectRatio', 'xlink:href', 'id', 'clip-path', 'clipPathUnits'],
        ALLOW_DATA_ATTR: false,
      }).replace('<svg ', '<svg style="max-width:100%;max-height:100%;width:auto;height:auto;display:block" ')
    } catch { svgPreview = null }
  }

  const previewBgClass = !isImage
    ? 'bg-[var(--panel-2-bg)]'
    : opts.background === 'transparent' && opts.format !== 'pdf'
      ? 'omm-checkerboard'
      : ''
  const previewInlineBg = isImage
    ? (opts.background === 'white' || (opts.format === 'pdf' && opts.background === 'transparent')
      ? '#FFFFFF'
      : opts.background === 'canvas'
        ? (analysis?.scene.canvasBg ?? 'var(--panel)')
        : undefined)
    : undefined

  return (
    <Modal title="Xuất tệp" onClose={close} wide
      footer={
        <>
          {stale && <span className="mr-auto rounded-lg bg-[var(--warningSoft)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--warning)]">Bản xem trước cũ — <button type="button" className="underline" onClick={() => setStale(false)}>Cập nhật</button></span>}
          <button type="button" onClick={close} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--text)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--hover)]">Hủy</button>
          <button type="button" onClick={doExport} disabled={!analysis || !!analysisError || busy || stale || (opts.format === 'png' && !!est?.exceedsLimit) || (opts.format === 'pdf' && !!pdfPlan && !pdfPlan.ok)}
            className="h-9 rounded-lg bg-[var(--accent)] px-5 text-[13px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)] disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? 'Đang xuất…' : 'Xuất file'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        {/* Preview 60-65% */}
        <div>
          <div data-export-preview-stage className={`flex h-[380px] md:h-[430px] items-center justify-center overflow-auto rounded-xl border border-[var(--border)] p-2 ${previewBgClass}`} style={previewInlineBg ? { background: previewInlineBg } : undefined}>
            {isImage && svgPreview && <div className="flex h-full w-full min-h-0 min-w-0 items-center justify-center" dangerouslySetInnerHTML={{ __html: svgPreview }} />}
            {isImage && !svgPreview && <div className="text-[12px] text-[var(--text2)]">{analysisError ?? 'Không dựng được bản xem trước'}</div>}
            {!isImage && analysis && (
              <pre className="h-full w-full overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--panel)] p-3 text-[11.5px] leading-relaxed text-[var(--text)]">
                {opts.format === 'json'
                  ? JSON.stringify({ schema_version: 3, name: doc.name, topics: opts.scope === 'branch' && opts.scopeRootId ? 1 + descendantsOf(doc, opts.scopeRootId).length : doc.topics.length, note: 'JSON đầy đủ — xem trước rút gọn' }, null, 2)
                  : (opts.format === 'md' ? exportMarkdown(doc, opts) : opts.format === 'opml' ? exportOPML(doc, opts) : exportTXT(doc, opts)).slice(0, 3000)}
              </pre>
            )}
            {!analysis && !isImage && <div className="max-w-full px-2 text-center text-[12px] text-[var(--danger)]">{analysisError ?? 'Không có nội dung để xuất'}</div>}
          </div>
          {/* Outliers */}
          {analysis && analysis.outliers.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-400 bg-amber-400/5 p-2 text-[11.5px]">
              <div className="font-medium">Cảnh báo vùng thừa (outlier) — {analysis.outliers.length} đối tượng:</div>
              {analysis.outliers.slice(0, 5).map((o) => (
                <div key={o.id} className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[var(--text2)]">{o.kind} · cách nội dung ~{o.distance}px</span>
                  <span className="flex gap-1">
                    <button type="button" className="rounded border border-[var(--border)] px-1.5" onClick={() => upd({ excludedDrawingIds: opts.excludedDrawingIds.filter((x) => x !== o.id) })}>Giữ</button>
                    <button type="button" className="rounded border border-[var(--border)] px-1.5" onClick={() => upd({ excludedDrawingIds: [...opts.excludedDrawingIds, o.id] })}>Loại khỏi lần xuất</button>
                  </span>
                </div>
              ))}
              <div className="mt-1 text-[10.5px] text-[var(--text2)]">Loại chỉ áp dụng cho lần xuất này, không xóa khỏi dự án.</div>
            </div>
          )}
          {est && (
            <div className={`mt-2 text-[11px] ${est.exceedsLimit ? 'text-[var(--danger)]' : 'text-[var(--text2)]'}`}>
              PNG ước tính: {est.w}×{est.h}px (≈ {est.megaPixels.toFixed(1)} MiPx)
              {est.exceedsLimit ? ` — vượt giới hạn ${est.exceedsEdge ? '16.384 px mỗi cạnh' : '64 MiPx (67.108.864 px)'}, hãy giảm tỷ lệ!` : ''}
            </div>
          )}
          {pdfPlan && (
            <div className={`mt-2 text-[11px] ${pdfPlan.ok ? 'text-[var(--text2)]' : 'text-[var(--danger)]'}`}>
              {pdfPlan.ok
                ? `Xem tổng quan — PDF nhiều trang: ${pdfPlan.pageCount} trang (${pdfPlan.xSlices.length} cột × ${pdfPlan.ySlices.length} hàng), cắt an toàn ngoài node/nhãn.`
                : pdfPlan.error}
            </div>
          )}
        </div>
        {/* Options */}
        <div className="space-y-2.5 text-[12.5px]">
          <Field label="Định dạng">
            <SelectField<ExportOptions['format']>
              value={opts.format}
              options={[
                { value: 'png', label: 'PNG (ảnh bitmap)' },
                { value: 'svg', label: 'SVG (vector)' },
                { value: 'pdf', label: 'PDF' },
                { value: 'json', label: 'JSON native (.mindmap.json)' },
                { value: 'md', label: 'Markdown (MindMap-MD-1)' },
                { value: 'opml', label: 'OPML' },
                { value: 'txt', label: 'TXT (thụt Tab)' },
              ]}
              onChange={(v) => upd({ format: v })}
            />
          </Field>
          <Field label="Phạm vi">
            <Segmented value={opts.scope} options={[{ value: 'entire', label: 'Toàn sơ đồ' }, { value: 'branch', label: 'Nhánh được chọn' }]}
              onChange={(v) => {
                const selected = useApp.getState().selection.find((id) => !!getTopic(doc, id)) ?? null
                upd({ scope: v, scopeRootId: v === 'branch' ? selected : null })
              }} />
            {opts.scope === 'branch' && !scopeError && opts.scopeRootId && <div className="mt-1 text-[11px] text-[var(--text2)]">Nhánh: “{getTopic(doc, opts.scopeRootId)?.text.slice(0, 40)}”</div>}
            {opts.scope === 'branch' && scopeError && <div className="mt-1 text-[11px] text-[var(--danger)]">{scopeError}</div>}
          </Field>
          {opts.format !== 'json' && (
            <Field label="Hiển thị node thu gọn">
              <Segmented value={opts.visibility} options={[{ value: 'includeCollapsed', label: 'Bao gồm (mở tạm)' }, { value: 'visibleOnly', label: 'Chỉ đang hiện' }]} onChange={(v) => upd({ visibility: v })} />
            </Field>
          )}
          {opts.format === 'json' && <div className="rounded bg-[var(--bg)] p-2 text-[11px] text-[var(--text2)]">JSON luôn bảo toàn toàn bộ dữ liệu (kể cả node thu gọn) — LOCK-10.</div>}
          {isImage && (
            <>
              <Field label="Nét vẽ (drawing)"><Row><ToggleField value={opts.includeDrawings} onChange={(v) => upd({ includeDrawings: v })} /></Row></Field>
              <Field label="Nền">
                <Segmented value={opts.background} options={[{ value: 'canvas', label: 'Màu map' }, { value: 'white', label: 'Trắng' }, { value: 'transparent', label: 'Trong suốt' }]} onChange={(v) => upd({ background: v })} />
              </Field>
              <Field label="Auto Fit + Lề">
                <Row>
                  <ToggleField aria-label="Bật Auto Fit" value={opts.autoFit} onChange={(v) => upd({ autoFit: v })} />
                  <NumberInput aria-label="Lề (%)" value={opts.paddingPercent === 'auto' ? null : opts.paddingPercent} min={0} max={10} unit="%" onCommit={(v) => upd({ paddingPercent: v === null ? 'auto' : v })} />
                </Row>
              </Field>
            </>
          )}
          {opts.format === 'png' && (
            <Field label="Tỷ lệ PNG">
              <Segmented value={String(opts.pngScale)} options={[{ value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '3', label: '3×' }]} onChange={(v) => upd({ pngScale: Number(v) as 1 | 2 | 3 })} />
            </Field>
          )}
          {opts.format === 'pdf' && (
            <>
              <Field label="Khổ giấy">
                <Segmented value={opts.pdfPaper} options={[{ value: 'content', label: 'Theo nội dung' }, { value: 'a4', label: 'A4' }, { value: 'a3', label: 'A3' }]} onChange={(v) => upd({ pdfPaper: v })} />
              </Field>
              {opts.pdfPaper !== 'content' && (
                <>
                  <Field label="Hướng">
                    <Segmented value={opts.pdfOrientation} options={[{ value: 'landscape', label: 'Ngang' }, { value: 'portrait', label: 'Dọc' }]} onChange={(v) => upd({ pdfOrientation: v })} />
                  </Field>
                  <Field label="Trang">
                    <Segmented value={opts.pdfMode} options={[{ value: 'onepage', label: 'Một trang (fit)' }, { value: 'multipage', label: 'Nhiều trang' }]} onChange={(v) => upd({ pdfMode: v })} />
                  </Field>
                </>
              )}
            </>
          )}
          {(opts.format === 'md' || opts.format === 'opml' || opts.format === 'txt') && (
            <div className="rounded bg-[var(--bg)] p-2 text-[11px] leading-relaxed text-[var(--text2)]">{LOSS_REPORT_TEXT[0]}</div>
          )}
          <Field label="Tên tệp">
            <TextInput value={opts.fileName} onChange={(e) => upd({ fileName: e.target.value })} className="bg-[var(--bg)]" />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/* ================= Cài đặt (15) ================= */
function normalizedSearch(text: string): string { return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd') }
function matchesSearch(text: string, query: string): boolean {
  const normalized = normalizedSearch(text)
  return normalizedSearch(query).trim().split(/\s+/).every(word => normalized.includes(word))
}
function settingsText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!React.isValidElement(node)) return ''
  const props = node.props as { label?: string; children?: React.ReactNode; options?: { label: string; value: string }[] }
  if (node.type === ShortcutsTable) return SHORTCUTS.flat().join(' ')
  return [props.label, props.options?.map(o => o.label + ' ' + o.value).join(' '), ...React.Children.toArray(props.children).map(settingsText)].filter(Boolean).join(' ')
}
function SettingsGroup({ title, query, children }: { title: string; query: string; children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(child => {
    if (!query.trim()) return true
    if (React.isValidElement(child) && child.type === ShortcutsTable) return SHORTCUTS.some(([key, description]) => matchesSearch(title + ' ' + key + ' ' + description, query))
    return matchesSearch(title + ' ' + settingsText(child), query)
  })
  if (!items.length) return null
  return <section className="mb-3">{query.trim() && <h3 className="mb-2 text-[13px] font-semibold">{title}</h3>}{items}</section>
}

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const resetGroup = useApp((s) => s.resetSettingsGroup)
  const [tab, setTab] = useState<'general' | 'map' | 'canvas' | 'storage' | 'shortcuts'>('general')
  const [query, setQuery] = useState('')
  const searching = !!query.trim()
  if (!open) return null
  const tabs = [
    { id: 'general', label: 'Chung' },
    { id: 'map', label: 'Mind Map' },
    { id: 'canvas', label: 'Canvas & Vẽ' },
    { id: 'storage', label: 'Lưu trữ' },
    { id: 'shortcuts', label: 'Phím tắt' },
  ] as const
  return (
    <Modal title="Cài đặt" onClose={() => setSettingsOpen(false)} wide
      footer={
        <>
          <button type="button" onClick={async () => { const st = useApp.getState(); if (await st.setSettings(defaultSettings())) st.toast('info', 'Đã khôi phục mặc định') }} className="mr-auto h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--hover)]">Khôi phục mặc định</button>
          <button type="button" onClick={() => setSettingsOpen(false)} className="h-9 rounded-lg border border-[var(--border-strong)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--hover)]">Đóng</button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[170px_minmax(0,1fr)]">
        <div className="space-y-0.5">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)} className={`w-full rounded-md px-3 py-1.5 text-left text-[12.5px] transition-colors ${tab === t.id ? 'bg-[var(--accentSoft)] font-medium text-[var(--accent)]' : 'text-[var(--text)] hover:bg-[var(--hover)]'}`}>{t.label}</button>
          ))}
          <input value={query} aria-label="Tìm cài đặt" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }} placeholder="Tìm cài đặt…" className="mt-2 h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[11.5px] focus:border-[var(--accent)]" />
        </div>
        <div>
          {searching && <p className="text-[12px] text-[var(--text2)] [&:not(:only-child)]:hidden">Không tìm thấy cài đặt phù hợp.</p>}
          {(searching || tab === 'general') && (
            <SettingsGroup title="Chung" query={query}>
              <Field label="Giao diện ứng dụng (độc lập với theme sơ đồ — LOCK-08)">
                <Segmented value={settings.appearance} options={[{ value: 'system', label: 'Theo hệ thống' }, { value: 'light', label: 'Sáng' }, { value: 'dark', label: 'Tối' }]} onChange={(v) => setSettings({ appearance: v as never })} />
              </Field>
              <Field label="Giảm chuyển động"><Row><ToggleField value={settings.reduceMotion} onChange={(v) => setSettings({ reduceMotion: v })} /></Row></Field>
              <button onClick={() => resetGroup('general')} className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-all hover:bg-[var(--hover)]">Đặt lại nhóm</button>
            </SettingsGroup>
          )}
          {(searching || tab === 'map') && (
            <SettingsGroup title="Mind Map" query={query}>
              <Field label="Bố cục mặc định cho dự án mới">
                <SelectField value={settings.defaultLayout} options={[
                  { value: 'balanced', label: 'Balanced' }, { value: 'logic', label: 'Logic' }, { value: 'tree', label: 'Tree' },
                  { value: 'organization', label: 'Organization' }, { value: 'radial', label: 'Radial' }, { value: 'fishbone', label: 'Fishbone' },
                  { value: 'timeline', label: 'Timeline' }, { value: 'freeform', label: 'Free-form' },
                ]} onChange={(v) => setSettings({ defaultLayout: v })} />
              </Field>
              <Field label="Chủ đề mặc định">
                <SelectField value={settings.defaultTheme} options={PROJECT_THEMES.map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => setSettings({ defaultTheme: v })} />
              </Field>
              <button onClick={() => resetGroup('map')} className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-all hover:bg-[var(--hover)]">Đặt lại nhóm</button>
            </SettingsGroup>
          )}
          {(searching || tab === 'canvas') && (
            <SettingsGroup title="Canvas & Vẽ" query={query}>
              <Field label="Lưới mặc định"><Row><ToggleField value={settings.gridVisible} onChange={(v) => setSettings({ gridVisible: v })} /></Row></Field>
              <Field label="Khoảng lưới"><NumberInput value={settings.gridSpacing} min={8} max={200} unit="world" onCommit={(v) => v !== null && setSettings({ gridSpacing: v })} /></Field>
              <Field label="Snap mặc định"><Row><ToggleField value={settings.snapToGrid} onChange={(v) => setSettings({ snapToGrid: v })} /></Row></Field>
              <Field label="Mini map mặc định"><Row><ToggleField value={settings.minimapDefault} onChange={(v) => setSettings({ minimapDefault: v })} /></Row></Field>
              <button onClick={() => resetGroup('canvas')} className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-all hover:bg-[var(--hover)]">Đặt lại nhóm</button>
            </SettingsGroup>
          )}
          {(searching || tab === 'storage') && (
            <SettingsGroup title="Lưu trữ" query={query}>
              <Field label="Auto Save"><Row><ToggleField value={settings.autosaveEnabled} onChange={(v) => setSettings({ autosaveEnabled: v })} /><span className="text-[11.5px] text-[var(--text2)]">Tắt vẫn giữ Draft Journal & backup (17.3)</span></Row></Field>
              <Field label="Khoảng Auto Save (ms)"><NumberInput value={settings.autosaveIntervalMs} min={200} max={10000} step={100} unit="ms" onCommit={(v) => v !== null && setSettings({ autosaveIntervalMs: v })} /></Field>
              <Field label="Số backup giữ lại"><NumberInput value={settings.backupCount} min={0} max={10} onCommit={(v) => v !== null && setSettings({ backupCount: v })} /></Field>
              <Field label="Draft Journal (khôi phục bản nháp đang gõ)"><Row><ToggleField value={settings.draftJournalEnabled} onChange={(v) => setSettings({ draftJournalEnabled: v })} /></Row></Field>
              <button onClick={() => resetGroup('storage')} className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--text)] transition-all hover:bg-[var(--hover)]">Đặt lại nhóm</button>
            </SettingsGroup>
          )}
          {(searching || tab === 'shortcuts') && <SettingsGroup title="Phím tắt" query={query}><ShortcutsTable compact query={query} /></SettingsGroup>}
        </div>
      </div>
    </Modal>
  )
}

/* ================= Thùng rác (PR05 Delete-to-Trash — hoàn thiện lối vào) =================
 * deleteProject đã ghi vào omm.trash.v3 từ trước nhưng không có UI xem/phục hồi.
 * Dialog này chỉ đọc/ghi qua các hàm storage đã có: trashList / removeFromTrash /
 * saveProjectAtomic / upsertMeta. Khôi phục: giữ ID gốc nếu trống, còn tồn tại thì
 * tạo bản sao ID mới (tái dùng pattern resolveConflictSaveAs). */
export function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Đọc trashList() trực tiếp lúc render (không setState trong effect);
  // refresh sau restore/purge bằng counter.
  const [, force] = useState(0)
  if (!open) return null
  const items = trashList()
  const restore = async (item: TrashItem) => {
    if (await useApp.getState().restoreTrash(item.id)) force(n => n + 1)
  }
  const purge = (item: TrashItem) => {
    useApp.getState().setConfirm({ message: `Xóa vĩnh viễn "${item.name}" khỏi thùng rác?`, detail: 'Không thể hoàn tác.', danger: true,
      onOk: async () => { const ok = await useApp.getState().purgeTrash(item.id); if (ok) force(n => n + 1); return ok },
    })
  }
  return (
    <Modal title="Thùng rác" onClose={onClose}>
      <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--text2)]">Dự án đã xóa nằm ở đây (tối đa 50 mục gần nhất). Khôi phục sẽ đưa dự án trở lại danh sách; xóa vĩnh viễn là không thể hoàn tác.</p>
      {!items.length && <div className="rounded-lg border border-dashed border-[var(--border)] py-8 text-center text-[12px] text-[var(--text3)]">Thùng rác trống</div>}
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel-2-bg)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-semibold text-[var(--text)]">{item.name}</span>
              <span className="shrink-0 text-[11px] text-[var(--text3)]">{new Date(item.deletedAt).toLocaleString('vi-VN')}</span>
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--text2)]">{item.doc.topics.length} node · xóa lúc {new Date(item.deletedAt).toLocaleTimeString('vi-VN')}</div>
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={() => restore(item)} className="h-8 rounded-lg bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)]">Khôi phục</button>
              <button type="button" onClick={() => purge(item)} className="h-8 rounded-lg border border-[var(--danger)] px-3 text-[12px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--dangerSoft)]">Xóa vĩnh viễn</button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ================= Recovery (13.2/17.3) ================= */
export function RecoveryDialog() {
  const recovery = useApp((s) => s.recovery)
  if (!recovery.open) return null
  return (
    <Modal title="Khôi phục dữ liệu" onClose={() => useApp.setState({ recovery: { open: false, candidates: [] } })}>
      <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--text2)]">Phát hiện phiên làm việc chưa đóng an toàn hoặc bản nháp chưa commit. Hãy xem và chọn cách khôi phục — không có gì bị ghi đè tự động.</p>
      <div className="space-y-2.5">
        {recovery.candidates.map((c, i) => (
          <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--panel-2-bg)] p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-[var(--text)]">{c.projectName}</span>
              <span className="text-[11px] text-[var(--text3)]">{new Date(c.timestamp).toLocaleString('vi-VN')}</span>
            </div>
            <div className="mt-1 text-[12px] text-[var(--text2)]"><span className="omm-chip mr-1">{c.kind === 'draft' ? 'Bản nháp' : 'Backup'}</span> {c.detail}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {c.kind === 'draft' && c.baseRaw && c.draft?.base_field_value !== undefined && <button type="button" onClick={() => useApp.getState().applyRecovery(i, false)} className="h-8 rounded-lg bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--onAccent)] shadow-sm transition-colors hover:bg-[var(--accentStrong)]">Khôi phục vào dự án</button>}
              <button type="button" onClick={() => useApp.getState().applyRecovery(i, true)} className="h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[12px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--hover)]">Khôi phục thành bản sao</button>
              <button type="button" onClick={() => useApp.getState().dismissRecovery(i)} className="h-8 rounded-lg px-3 text-[12px] font-medium text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]">Bỏ qua</button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ================= Confirm ================= */
export function ConfirmDialog() {
  const confirm = useApp((s) => s.confirm)
  const [busy, setBusy] = useState(false)
  if (!confirm) return null
  return (
    <Modal title="Xác nhận" onClose={() => { if (!busy) useApp.getState().setConfirm(null) }}
      footer={
        <>
          <button type="button" disabled={busy} onClick={() => { if (!busy) useApp.getState().setConfirm(null) }} className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--text)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--hover)]">Hủy</button>
          <button type="button" disabled={busy} onClick={async () => {
            if (busy) return
            setBusy(true)
            try {
              const ok = await confirm.onOk()
              if (ok !== false && useApp.getState().confirm === confirm) useApp.getState().setConfirm(null)
            } catch (e) { useApp.getState().toast('error', 'Thao tác thất bại', String(e)) }
            finally { setBusy(false) }
          }}
            className={`h-9 rounded-lg px-4 text-[13px] font-medium text-[var(--onAccent)] shadow-sm transition-colors ${confirm.danger ? 'bg-[var(--danger)] hover:opacity-90' : 'bg-[var(--accent)] hover:bg-[var(--accentStrong)]'}`}>Xác nhận</button>
        </>
      }>
      <p className="text-[13.5px] font-medium text-[var(--text)]">{confirm.message}</p>
      {confirm.detail && <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text2)]">{confirm.detail}</p>}
    </Modal>
  )
}

export function LeaveProjectDialog() {
  const prompt = useApp(s => s.leavePrompt)
  if (!prompt) return null
  return <Modal title="Thay đổi chưa lưu" onClose={() => void useApp.getState().chooseLeave('cancel')}
    footer={<>
      <button className="min-h-9 rounded-lg border border-[var(--border)] px-3 text-[12.5px] hover:bg-[var(--hover)]" onClick={() => void useApp.getState().chooseLeave('cancel')}>Hủy</button>
      <button className="min-h-9 rounded-lg border border-[var(--border)] px-3 text-[12.5px] hover:bg-[var(--hover)]" onClick={() => void useApp.getState().chooseLeave('discard')}>Bỏ thay đổi</button>
      <button className="min-h-9 rounded-lg border border-[var(--border)] px-3 text-[12.5px] hover:bg-[var(--hover)]" onClick={() => void useApp.getState().chooseLeave('save')}>Lưu và tiếp tục</button>
    </>}>
    <p>Dự án có nội dung hoặc bản nháp chưa lưu. Hãy chọn cách xử lý trước khi tiếp tục.</p>
  </Modal>
}

/* ================= Phím tắt ================= */
const SHORTCUTS: [string, string][] = [
  ['Tab', 'Thêm chủ đề con'],
  ['Enter', 'Thêm chủ đề ngang hàng'],
  ['F2 / Double-click', 'Sửa tiêu đề node'],
  ['Delete', 'Xóa nhánh (>20 node sẽ hỏi)'],
  ['Ctrl+D', 'Nhân bản nhánh'],
  ['Ctrl+C / X / V', 'Sao chép / cắt / dán nhánh'],
  ['Ctrl+Z / Y', 'Hoàn tác / làm lại'],
  ['Ctrl+F', 'Tìm & thay thế'],
  ['Ctrl+S', 'Lưu ngay'],
  ['Ctrl+N / O', 'Dự án mới / mở sidebar'],
  ['Ctrl+I / E', 'Nhập / Xuất'],
  ['Ctrl+0', 'Vừa khít toàn sơ đồ'],
  ['Ctrl+= / Ctrl+-', 'Phóng to / thu nhỏ'],
  ['Ctrl+A', 'Chọn tất cả node'],
  ['Ctrl+,', 'Cài đặt'],
  ['Kéo node (auto layout)', 'Chuyển cha / sắp xếp thứ tự / gán bên'],
  ['Kéo node (Free-form)', 'Di chuyển tọa độ (không đổi cha)'],
  ['Space + kéo / chuột giữa', 'Pan canvas'],
  ['Ctrl+_wheel', 'Zoom tại con trỏ'],
  ['Kéo chấm xanh cạnh node', 'Nối chéo (crosslink)'],
  ['V / P / H / E / L / R / O', 'Công cụ: chọn/bút/đánh dấu/tẩy/thẳng/chữ nhật/elip'],
  ['Esc', 'Hủy thao tác / thoát focus / đóng lớp trên cùng'],
]
function ShortcutsTable({ compact, query = '' }: { compact?: boolean; query?: string }) {
  return (
    <div className={`overflow-hidden rounded-lg border border-[var(--border)] ${compact ? '' : 'mx-auto max-w-[560px]'}`}>
      <table className="w-full text-[12.5px]">
        <tbody>
          {SHORTCUTS.filter(([k, d]) => matchesSearch('Phím tắt ' + k + ' ' + d, query)).map(([k, d], i) => (
            <tr key={k} className={i % 2 ? 'bg-[var(--bg)]' : ''}>
              <td className="w-[190px] px-3 py-1.5 font-medium">{k}</td>
              <td className="px-3 py-1.5 text-[var(--text2)]">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export function ShortcutsDialog() {
  const open = useApp((s) => s.shortcutsOpen)
  const setShortcutsOpen = useApp((s) => s.setShortcutsOpen)
  if (!open) return null
  return (
    <Modal title="Phím tắt" onClose={() => setShortcutsOpen(false)} wide>
      <ShortcutsTable />
    </Modal>
  )
}

/* ================= About / Guide ================= */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <Modal title="Giới thiệu" onClose={onClose} footer={<button type="button" onClick={onClose} className="h-9 rounded-lg border border-[var(--border-strong)] bg-[var(--panel)] px-4 text-[13px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--hover)]">Đóng</button>}>
      <div className="space-y-2 text-[13px]">
        <div className="flex items-center gap-3">
          <img src="/openmindmap-logo-v4.png" alt="OpenMindmap" className="h-12 w-12 rounded-2xl shadow-sm" />
          <div>
            <div className="text-[15px] font-semibold">OpenMindmap (MindMap App V3.5 Web)</div>
            <div className="text-[12px] text-[var(--text2)]">Phiên bản 3.5.0-web · UI tiếng Việt · offline-first</div>
          </div>
        </div>
        <p className="text-[12.5px] leading-relaxed text-[var(--text2)]">
          Cài đặt web của đặc tả MindMap App V3.5: một dự án = một sơ đồ, một chủ đề trung tâm + chủ đề nổi,
          8 bố cục, nhập 4 / xuất 7 định dạng, Command + Undo/Redo, Auto Save có xác thực ghi,
          Draft Journal khôi phục bản nháp, JSON schema v3 có migration v1/v2.
        </p>
      </div>
    </Modal>
  )
}
export function GuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <Modal title="Hướng dẫn sử dụng" onClose={onClose} wide footer={<button type="button" onClick={onClose} className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-[var(--onAccent)] hover:bg-[var(--accentStrong)]">Bắt đầu thôi</button>}>
      <div className="space-y-3 text-[12.5px] leading-relaxed">
        <section>
          <h3 className="mb-1 font-semibold">1. Tạo & quản lý dự án</h3>
          <p className="text-[var(--text2)]">Nhấn <b>+ Tạo dự án</b> ở sidebar (hoặc Ctrl+N). Danh sách dự án ở sidebar hỗ trợ tìm kiếm, đổi tên (double-click), nhân bản, chuyển vào thùng rác qua menu chuột phải. Mỗi dự án tự lưu (Auto Save có xác thực — trạng thái “Đã lưu” trên thanh công cụ chỉ hiện khi ghi thành công).</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">2. Thêm & biên tập node</h3>
          <p className="text-[var(--text2)]">Chọn node → <b>Tab</b> thêm con, <b>Enter</b> thêm ngang hàng, <b>F2</b> hoặc double-click để sửa tiêu đề (Enter ghi, Shift+Enter xuống dòng, Esc hủy). Ghi chú Markdown, checkbox, ngày, liên kết, icon, ảnh nằm trong Inspector (Nội dung / Ảnh và biểu tượng).</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">3. Kéo thả</h3>
          <p className="text-[var(--text2)]">Ở bố cục tự động: kéo node vào <b>bên trong</b> node khác = chuyển cha (viền xanh); kéo vào <b>khe giữa</b> hai node = đổi thứ tự (vạch chèn); kéo ra xa ở Balanced = gán bên trái/phải. Ở Free-form: kéo = di chuyển tọa độ; muốn di chuyển cả nhánh bật “Di chuyển cả nhánh” trong menu chuột phải; kéo chấm xanh cạnh node để nối chéo hoặc chuyển cha.</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">4. Vẽ tay</h3>
          <p className="text-[var(--text2)]">Nhấn <b>Vẽ</b> trên thanh công cụ: bút, đánh dấu, tẩy đối tượng, đường thẳng, chữ nhật, elip. Nét vẽ ở hệ tọa độ world riêng — đổi bố cục không làm nét vẽ di chuyển (LOCK-07).</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">5. Xuất tệp</h3>
          <p className="text-[var(--text2)]"><b>Xuất</b> (Ctrl+E) hỗ trợ 7 định dạng: PNG/SVG/PDF (xem trước + Auto Fit + cảnh báo vùng thừa) và JSON/MD/OPML/TXT (theo profile canonical, có báo cáo mất dữ liệu). JSON luôn bảo toàn toàn bộ dữ liệu.</p>
        </section>
      </div>
    </Modal>
  )
}
