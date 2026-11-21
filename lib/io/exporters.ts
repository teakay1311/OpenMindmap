/* ============================================================
 * OpenMindmap — lib/io/exporters.ts
 * Xuất 7 định dạng: JSON, MD, OPML, TXT, PNG, SVG, PDF (LOCK-10)
 * Pipeline: DocSnapshot → Layout+Measure → SceneGraph → bounds →
 *           outlier → padding → SVG canonical → raster/vector
 * Không dùng screenshot viewport (LOCK-08/14.7).
 * ============================================================ */
import jsPDF from 'jspdf'
import { ProjectDocV3, Topic, DrawingObject, LIMITS } from '../core/types'
import { childrenOf, getTopic, rootsOf, descendantsOf } from '../core/tree'
import { buildScene, sceneToSVG, SceneOpts, Scene, CROSSLINK_LABEL_FONT } from '../scene/scene'

export type ExportFormat = 'json' | 'md' | 'opml' | 'txt' | 'png' | 'svg' | 'pdf'

export interface ExportOptions {
  format: ExportFormat
  scope: 'entire' | 'branch'
  scopeRootId?: string | null
  visibility: 'includeCollapsed' | 'visibleOnly'
  includeDrawings: boolean
  excludedDrawingIds: string[]
  background: 'transparent' | 'white' | 'canvas'
  autoFit: boolean
  paddingPercent: number | 'auto' // 0..10
  pngScale: 1 | 2 | 3
  pdfPaper: 'content' | 'a4' | 'a3'
  pdfOrientation: 'portrait' | 'landscape'
  pdfMode: 'onepage' | 'multipage'
  fileName: string
}

export interface OutlierInfo { id: string; kind: string; distance: number }

export const LOSS_REPORT_TEXT = [
  'Mất: tọa độ & bố cục tự do, style chữ/hình khối, theme màu, crosslink, nét vẽ, ảnh đính kèm.',
]


/* ---------- Scope validation (14.2): one place for preview + exporters ---------- */
/** Resolve the branch root once. Invalid/stale scope must never fall back to the whole map. */
export function exportScopeError(doc: ProjectDocV3, opts: Pick<ExportOptions, 'scope' | 'scopeRootId'>): string | null {
  if (opts.scope !== 'branch') return null
  if (!opts.scopeRootId) return 'Chưa chọn node cho phạm vi nhánh. Hãy chọn một node hoặc đổi sang Toàn sơ đồ.'
  if (!getTopic(doc, opts.scopeRootId)) return 'Node của phạm vi xuất không còn tồn tại. Hãy chọn lại nhánh hoặc đổi sang Toàn sơ đồ.'
  return null
}

export function exportScopeRoot(doc: ProjectDocV3, opts: Pick<ExportOptions, 'scope' | 'scopeRootId'>): ReturnType<typeof getTopic> {
  if (opts.scope !== 'branch') return undefined
  const err = exportScopeError(doc, opts)
  if (err) throw new Error(err)
  return getTopic(doc, opts.scopeRootId!)!
}

/* ---------- Bounds & Outlier (14.7 Bounds Warning) ---------- */
export function analyzeExport(doc: ProjectDocV3, opts: ExportOptions): { scene: Scene; outliers: OutlierInfo[]; padding: number } {
  const scopeRoot = exportScopeRoot(doc, opts)
  const sceneOpts: SceneOpts = {
    includeCollapsed: opts.visibility === 'includeCollapsed',
    includeDrawings: opts.includeDrawings && opts.excludedDrawingIds.length < (doc.drawings.length || 1) ? true : opts.includeDrawings,
    scopeRoot: scopeRoot?.id ?? null,
  }
  // Bmain: node + edges (KHÔNG nét vẽ) — biên so sánh cho cảnh báo outlier.
  // (Trước đây bMain tính từ scene CÓ nét vẽ nên không nét nào từng "ngoài biên"
  // => cảnh báo vùng thừa không bao giờ hoạt động.)
  const baseScene = buildScene({ ...doc }, { ...sceneOpts, includeDrawings: false })
  const bMain = baseScene.bounds
  let bAll = { ...bMain }
  let drawings = doc.drawings
  if (opts.includeDrawings && doc.drawings.length) {
    const drawnScene = buildScene(doc, { ...sceneOpts, includeDrawings: true })
    bAll = drawnScene.bounds
    drawings = drawnScene.drawings.map(({ obj }) => obj)
  }
  const outliers: OutlierInfo[] = []
  const areaRatio = (bAll.w * bAll.h) / Math.max(1, bMain.w * bMain.h)
  const dimRatio = Math.max(bAll.w / Math.max(1, bMain.w), bAll.h / Math.max(1, bMain.h))
  if (opts.includeDrawings && (areaRatio > 1.5 || dimRatio > 1.25)) {
    const cx = bMain.x + bMain.w / 2, cy = bMain.y + bMain.h / 2
    for (const d of drawings) {
      const pts = d.points
      if (!pts.length) continue
      const dcx = pts.reduce((a, p) => a + p.x, 0) / pts.length
      const dcy = pts.reduce((a, p) => a + p.y, 0) / pts.length
      const dist = Math.hypot(dcx - cx, dcy - cy)
      const outside = pts.every((p) => p.x < bMain.x || p.x > bMain.x + bMain.w || p.y < bMain.y || p.y > bMain.y + bMain.h)
      if (outside && dist > Math.max(bMain.w, bMain.h)) {
        outliers.push({ id: d.id, kind: kindVN(d), distance: Math.round(dist) })
      }
    }
  }
  const minDim = Math.min(bMain.w, bMain.h)
  const padding = opts.paddingPercent === 'auto'
    ? Math.min(96, Math.max(12, Math.round(0.04 * minDim)))
    : Math.round((opts.paddingPercent / 100) * minDim)
  // Lọc drawings bị loại TRƯỚC khi dựng scene xuất => bounds/ước lượng không còn
  // bị nét bị loại phình to (trước đây lọc SAU buildScene nên bounds sai).
  const keptDoc = opts.excludedDrawingIds.length
    ? { ...doc, drawings: doc.drawings.filter((d) => !opts.excludedDrawingIds.includes(d.id)) }
    : doc
  const scene = buildScene(keptDoc, { ...sceneOpts, includeDrawings: opts.includeDrawings })
  return { scene, outliers, padding }
}
function kindVN(d: DrawingObject): string {
  return { pen: 'Nét bút', highlighter: 'Đánh dấu', line: 'Đường thẳng', rect: 'Hình chữ nhật', ellipse: 'Hình elip' }[d.kind]
}

/* ---------------- JSON ---------------- */
export function exportJSON(doc: ProjectDocV3, opts: ExportOptions): string {
  if (opts.scope === 'branch') {
    const root = exportScopeRoot(doc, opts)
    if (root) {
      const ids = new Set<string>([root.id])
      descendantsOf(doc, root.id).forEach((d) => ids.add(d.id))
      const topics = doc.topics.filter((t) => ids.has(t.id)).map((t) => ({
        ...structuredClone(t),
        role: t.id === root.id ? ('central' as const) : ('normal' as const),
        parent_id: t.id === root.id ? null : t.parent_id,
      }))
      const drawingIds = new Set(opts.includeDrawings && doc.drawings.length
        ? analyzeExport(doc, { ...opts, visibility: 'includeCollapsed' }).scene.drawings.map(({ obj }) => obj.id)
        : [])
      const out: ProjectDocV3 = {
        ...structuredClone(doc),
        project_id: doc.project_id, // giữ project_id khi xuất (mở lại là dự án độc lập có ID riêng khi import)
        name: root.text,
        central_topic_id: root.id,
        topics,
        crosslinks: doc.crosslinks.filter((c) => ids.has(c.source) && ids.has(c.target)),
        assets: doc.assets.filter((a) => topics.some((t) => t.image?.asset_id === a.id)),
        drawings: doc.drawings.filter(d => drawingIds.has(d.id)),
        document_revision: 1,
      }
      return JSON.stringify(out, null, 2)
    }
  }
  return JSON.stringify(doc, null, 2)
}

/* ---------------- Markdown — MindMap-MD-1 ---------------- */
export function exportMarkdown(doc: ProjectDocV3, opts: ExportOptions): string {
  const visibleOnly = opts.visibility === 'visibleOnly'
  const esc = (s: string) => s.replace(/\n/g, ' ')
  const lines2: string[] = []
  const roots = rootsOf(doc)
  const scopeRoot = exportScopeRoot(doc, opts)
  const scopeRoots = scopeRoot ? [scopeRoot] : roots
  scopeRoots.forEach((root, ri) => {
    lines2.push(`# ${esc(root.text)}`, '')
    // Ghi chú của root: exporter trước đây bỏ sót (chỉ xuất note node con) trong khi
    // OPML giữ được và importer đã hỗ trợ path root ("0", "1", ...) => mất dữ liệu
    // ngầm. Phát marker cùng cú pháp với note node con, topic-path theo chỉ số root.
    if (root.notes) {
      lines2.push(`<!-- mindmap-note:start topic-path="${ri}" -->`)
      root.notes.split('\n').forEach((nl) => lines2.push(nl))
      lines2.push('<!-- mindmap-note:end -->', '')
    }
    const emit = (pid: string, depth: number, path: string) => {
      childrenOf(doc, pid).forEach((k, i) => {
        const ind = '  '.repeat(depth)
        const cb = k.checkbox === true ? '[x] ' : k.checkbox === false ? '[ ] ' : ''
        lines2.push(`${ind}- ${cb}${esc(k.text)}`)
        if (k.notes) {
          lines2.push(`${ind}  <!-- mindmap-note:start topic-path="${path}.${i}" -->`)
          k.notes.split('\n').forEach((nl) => lines2.push(`${ind}  ${nl}`))
          lines2.push(`${ind}  <!-- mindmap-note:end -->`)
        }
        if (!(visibleOnly && k.collapsed)) emit(k.id, depth + 1, `${path}.${i}`)
      })
    }
    emit(root.id, 0, String(ri))
  })
  return lines2.join('\n') + '\n'
}

/* ---------------- OPML — MindMap-OPML-1 ---------------- */
export function exportOPML(doc: ProjectDocV3, opts: ExportOptions): string {
  const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const visibleOnly = opts.visibility === 'visibleOnly'
  const scopeRoot = exportScopeRoot(doc, opts)
  const roots = scopeRoot ? [scopeRoot] : rootsOf(doc)
  const serializeOutlineAttrs = (node: Topic): string[] => {
    const attrs = [`text="${escXml(node.text)}"`]
    if (node.notes) attrs.push(`_note="${escXml(node.notes)}"`)
    if (node.checkbox !== null && node.checkbox !== undefined) attrs.push(`isChecked="${node.checkbox}"`)
    if (node.url) attrs.push(`url="${escXml(node.url)}"`)
    return attrs
  }
  const emit = (t: ProjectDocV3, pid: string, depth: number): string[] => {
    const lines: string[] = []
    childrenOf(t, pid).forEach((k) => {
      const attrs = serializeOutlineAttrs(k)
      if (k.collapsed && visibleOnly) {
        lines.push(`${'  '.repeat(depth)}<outline ${attrs.join(' ')}/>`)
        return
      }
      const kids = emit(t, k.id, depth + 1)
      if (kids.length) {
        lines.push(`${'  '.repeat(depth)}<outline ${attrs.join(' ')}>`, ...kids, `${'  '.repeat(depth)}</outline>`)
      } else {
        lines.push(`${'  '.repeat(depth)}<outline ${attrs.join(' ')}/>`)
      }
    })
    return lines
  }
  const body = roots.flatMap((r) => {
    const attrs = serializeOutlineAttrs(r)
    const kids = r.collapsed && visibleOnly ? [] : emit(doc, r.id, 2)
    return kids.length
      ? [`    <outline ${attrs.join(' ')}>`, ...kids, '    </outline>']
      : [`    <outline ${attrs.join(' ')}/>`]
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escXml(doc.name)}</title>`,
    '  </head>',
    '  <body>',
    ...body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n')
}

/* ---------------- TXT — MindMap-TXT-1 ---------------- */
export function exportTXT(doc: ProjectDocV3, opts: ExportOptions): string {
  const encode = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n')
  const visibleOnly = opts.visibility === 'visibleOnly'
  const scopeRoot = exportScopeRoot(doc, opts)
  const roots = scopeRoot ? [scopeRoot] : rootsOf(doc)
  const lines: string[] = []
  const emit = (pid: string, depth: number) => {
    childrenOf(doc, pid).forEach((k) => {
      // SRS 14.6.3: một Tab cho một cấp khi Export
      lines.push(`${'\t'.repeat(depth)}${encode(k.text)}`)
      if (!(visibleOnly && k.collapsed)) emit(k.id, depth + 1)
    })
  }
  roots.forEach((r) => {
    lines.push(encode(r.text))
    if (!(visibleOnly && r.collapsed)) emit(r.id, 1)
  })
  return lines.join('\n') + '\n'
}

/* ---------------- SVG / PNG / PDF ---------------- */
export function exportSVG(scene: Scene, opts: ExportOptions, padding?: number): string {
  const p = padding ?? analyzePadding(opts).padding
  return sceneToSVG(scene, { background: opts.background, padding: p })
}
export function analyzePadding(opts: ExportOptions): { padding: number } {
  // đã tính trong analyzeExport; giữ API cho caller
  const minDim = 400
  const padding = opts.paddingPercent === 'auto' ? Math.min(96, Math.max(12, Math.round(0.04 * minDim))) : Math.round((opts.paddingPercent / 100) * minDim)
  return { padding }
}

export function pngDimensionsFromWorld(worldW: number, worldH: number, scale: number): { w: number; h: number } {
  const safeW = Number.isFinite(worldW) ? Math.max(0, worldW) : 0
  const safeH = Number.isFinite(worldH) ? Math.max(0, worldH) : 0
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    w: Math.max(1, Math.ceil(safeW * safeScale)),
    h: Math.max(1, Math.ceil(safeH * safeScale)),
  }
}

export async function rasterizeSVG(svg: string, scale: number, background: boolean | string): Promise<HTMLCanvasElement> {
  const vbMatch = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/)
  if (!vbMatch) throw new Error('SVG không hợp lệ')
  const vbW = Number(vbMatch[3]), vbH = Number(vbMatch[4])
  if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) throw new Error('SVG viewBox không hợp lệ')
  const { w, h } = pngDimensionsFromWorld(vbW, vbH, scale)
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w > LIMITS.pngMaxEdge || h > LIMITS.pngMaxEdge || w * h > LIMITS.pngMaxPixels) {
    throw new Error(`Kích thước PNG (${w}×${h}px) vượt giới hạn ${LIMITS.pngMaxEdge}px / 64 MiPx. Hãy giảm scale.`)
  }
  const fillBg = typeof background === 'string' ? background : background ? null : '#FFFFFF'
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Không raster được SVG (kiểm tra ảnh nhúng).'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    if (fillBg) {
      ctx.fillStyle = fillBg
      ctx.fillRect(0, 0, w, h)
    }
    ctx.drawImage(img, 0, 0, w, h)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Lỗi tạo PNG'))), 'image/png'))
}

export interface PdfPartitionPlan {
  ok: boolean
  error?: string
  vb: { x: number; y: number; w: number; h: number }
  pageW: number
  pageH: number
  scale: number
  pointsPerPixel: number
  totalPxW: number
  totalPxH: number
  xSlices: { from: number; to: number }[]
  ySlices: { from: number; to: number }[]
  pageCount: number
}

const PDF_PAPER_PT: Record<'a4' | 'a3', [number, number]> = {
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
}

function partitionAxis(totalPx: number, maxPagePx: number, intervals: { start: number; end: number }[]): { from: number; to: number }[] | null {
  if (totalPx <= maxPagePx) return [{ from: 0, to: totalPx }]
  if (maxPagePx < 1) return null
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { start: number; end: number }[] = []
  for (const iv of sorted) {
    const s = Math.max(0, iv.start), e = Math.min(totalPx, iv.end)
    if (e <= s) continue
    if (!merged.length || s >= merged[merged.length - 1].end) merged.push({ start: s, end: e })
    else merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, e)
  }
  const slices: { from: number; to: number }[] = []
  let pos = 0
  while (pos < totalPx) {
    const limit = Math.min(totalPx, pos + maxPagePx)
    if (limit >= totalPx) {
      slices.push({ from: pos, to: totalPx })
      break
    }
    let cut = limit
    while (cut > pos) {
      const hit = merged.find((iv) => cut > iv.start && cut < iv.end)
      if (!hit) break
      cut = Math.min(cut - 1, hit.start)
    }
    if (cut <= pos) return null
    slices.push({ from: pos, to: cut })
    pos = cut
  }
  return slices
}

export function planPdfMultipage(scene: Scene, opts: Pick<ExportOptions, 'pdfPaper' | 'pdfOrientation' | 'pngScale'>, padding: number): PdfPartitionPlan {
  const vb = {
    x: scene.bounds.x - padding,
    y: scene.bounds.y - padding,
    w: scene.bounds.w + padding * 2,
    h: scene.bounds.h + padding * 2,
  }
  const scale = Math.max(2, opts.pngScale)
  const worldToPt = 72 / 96 // 0.75
  const [rawW, rawH] = opts.pdfPaper === 'a3' ? PDF_PAPER_PT.a3 : PDF_PAPER_PT.a4
  const pageW = opts.pdfOrientation === 'landscape' ? rawH : rawW
  const pageH = opts.pdfOrientation === 'landscape' ? rawW : rawH
  const { w: totalPxW, h: totalPxH } = pngDimensionsFromWorld(vb.w, vb.h, scale)
  const pointsPerPixel = (vb.w * worldToPt) / totalPxW
  const maxPagePxW = Math.floor(pageW / pointsPerPixel)
  const maxPagePxH = Math.floor(pageH / pointsPerPixel)

  const xIntervals: { start: number; end: number }[] = []
  const yIntervals: { start: number; end: number }[] = []
  for (const n of scene.nodes) {
    const sw = n.strokeWidth / 2
    const left = Math.min(n.box.x - sw, n.textBounds.x, n.image?.x ?? Infinity)
    const top = Math.min(n.box.y - sw, n.textBounds.y, n.image?.y ?? Infinity)
    const right = Math.max(n.box.x + n.box.w + sw + (n.shadow ? 6 : 0), n.textBounds.x + n.textBounds.w, n.image ? n.image.x + n.image.w : -Infinity)
    const bottom = Math.max(n.box.y + n.box.h + sw + (n.shadow ? 6 : 0), n.textBounds.y + n.textBounds.h, n.image ? n.image.y + n.image.h : -Infinity)
    xIntervals.push({ start: Math.floor((left - vb.x) * scale) - 1, end: Math.ceil((right - vb.x) * scale) + 1 })
    yIntervals.push({ start: Math.floor((top - vb.y) * scale) - 1, end: Math.ceil((bottom - vb.y) * scale) + 1 })
  }
  const labelStrokeHalf = CROSSLINK_LABEL_FONT.stroke / 2
  for (const c of scene.crosslinks) {
    if (!c.labelBox) continue
    xIntervals.push({ start: Math.floor((c.labelBox.x - labelStrokeHalf - vb.x) * scale) - 1, end: Math.ceil((c.labelBox.x + c.labelBox.w + labelStrokeHalf - vb.x) * scale) + 1 })
    yIntervals.push({ start: Math.floor((c.labelBox.y - labelStrokeHalf - vb.y) * scale) - 1, end: Math.ceil((c.labelBox.y + c.labelBox.h + labelStrokeHalf - vb.y) * scale) + 1 })
  }
  const xSlices = partitionAxis(totalPxW, maxPagePxW, xIntervals)
  const ySlices = partitionAxis(totalPxH, maxPagePxH, yIntervals)
  if (!xSlices || !ySlices) {
    return {
      ok: false,
      error: 'Không tìm được điểm chia trang an toàn mà không cắt ngang node hoặc nhãn trên khổ giấy này. Hãy chọn "Một trang (fit)" hoặc khổ giấy lớn hơn.',
      vb, pageW, pageH, scale, pointsPerPixel, totalPxW, totalPxH, xSlices: [], ySlices: [], pageCount: 0,
    }
  }
  return {
    ok: true, vb, pageW, pageH, scale, pointsPerPixel, totalPxW, totalPxH,
    xSlices, ySlices, pageCount: xSlices.length * ySlices.length,
  }
}

/* PDF: cùng SVG → raster → jsPDF; content-size hoặc A4/A3, một/nhiều trang */
export async function exportPDF(scene: Scene, opts: ExportOptions, padding: number): Promise<Blob> {
  const scale = Math.max(2, opts.pngScale)
  const vb = {
    x: scene.bounds.x - padding,
    y: scene.bounds.y - padding,
    w: scene.bounds.w + padding * 2,
    h: scene.bounds.h + padding * 2,
  }
  const effectiveBg = opts.background === 'transparent' ? 'white' : opts.background
  const svg = sceneToSVG(scene, { background: effectiveBg, padding })
  const bgColor = effectiveBg === 'canvas' ? scene.canvasBg : '#FFFFFF'
  const worldToPt = 72 / 96 // 0.75
  const contentWpt = vb.w * worldToPt
  const contentHpt = vb.h * worldToPt

  let pdf: jsPDF
  let pageW: number, pageH: number
  if (opts.pdfPaper === 'content') {
    const maxPagePoints = 14_400
    const pageScale = Math.min(1, maxPagePoints / Math.max(contentWpt, contentHpt))
    const width = Math.min(maxPagePoints, Math.max(contentWpt * pageScale, 28))
    const height = Math.min(maxPagePoints, Math.max(contentHpt * pageScale, 28))
    pdf = new jsPDF({ unit: 'pt', format: [width, height], orientation: width > height ? 'landscape' : 'portrait' })
  } else {
    const paper = opts.pdfPaper === 'a4' ? 'a4' : 'a3'
    pdf = new jsPDF({ unit: 'pt', format: paper, orientation: opts.pdfOrientation })
  }
  pageW = pdf.internal.pageSize.getWidth()
  pageH = pdf.internal.pageSize.getHeight()

  const paintPage = () => {
    pdf.setFillColor(bgColor)
    pdf.rect(0, 0, pageW, pageH, 'F')
  }
  if (opts.pdfPaper === 'content' || opts.pdfMode === 'onepage') {
    const areaScale = Math.sqrt((16 * 1024 * 1024) / (vb.w * vb.h)) * 1.2 || scale
    const edgeScale = opts.pdfPaper === 'content' ? (LIMITS.pngMaxEdge - 1) / Math.max(vb.w, vb.h) : scale
    const raster = await rasterizeSVG(svg, Math.min(scale, areaScale, edgeScale), bgColor)
    const dataUrl = raster.toDataURL('image/jpeg', 0.92)
    const fit = Math.min(pageW / contentWpt, pageH / contentHpt)
    const w = contentWpt * fit, h = contentHpt * fit
    const ox = (pageW - w) / 2, oy = (pageH - h) / 2
    paintPage()
    pdf.addImage(dataUrl, 'JPEG', ox, oy, w, h, undefined, 'FAST')
    return pdf.output('blob')
  }
  const plan = planPdfMultipage(scene, opts, padding)
  if (!plan.ok) throw new Error(plan.error)
  const raster = await rasterizeSVG(svg, plan.scale, bgColor)
  let first = true
  for (const ys of plan.ySlices) {
    for (const xs of plan.xSlices) {
      const tw = xs.to - xs.from, th = ys.to - ys.from
      const tile = document.createElement('canvas')
      tile.width = tw
      tile.height = th
      tile.getContext('2d')!.drawImage(raster, xs.from, ys.from, tw, th, 0, 0, tw, th)
      if (!first) pdf.addPage()
      first = false
      paintPage()
      pdf.addImage(tile.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, tw * plan.pointsPerPixel, th * plan.pointsPerPixel, undefined, 'FAST')
    }
  }
  return pdf.output('blob')
}

export function estimatePNG(scene: Scene, padding: number, scale: number): {
  w: number; h: number; pixels: number; megaPixels: number; exceedsEdge: boolean; exceedsArea: boolean; exceedsLimit: boolean
} {
  const { w, h } = pngDimensionsFromWorld(scene.bounds.w + padding * 2, scene.bounds.h + padding * 2, scale)
  const pixels = w * h
  const megaPixels = pixels / (1024 * 1024)
  const exceedsEdge = w > LIMITS.pngMaxEdge || h > LIMITS.pngMaxEdge
  const exceedsArea = pixels > LIMITS.pngMaxPixels
  return { w, h, pixels, megaPixels, exceedsEdge, exceedsArea, exceedsLimit: exceedsEdge || exceedsArea }
}

export function sanitizeFileName(name: string): string {
  return (name || 'du-an').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function download(blobOrText: Blob | string, fileName: string): void {
  const blob = typeof blobOrText === 'string' ? new Blob([blobOrText], { type: 'text/plain;charset=utf-8' }) : blobOrText
  const wk = typeof window !== 'undefined'
    ? (window as unknown as {
        __OMM_NATIVE_MACOS__?: { platform?: string }
        webkit?: { messageHandlers?: { ommDownload?: { postMessage: (msg: unknown) => void } } }
      })
    : undefined
  if (wk?.__OMM_NATIVE_MACOS__?.platform === 'macos' && wk.webkit?.messageHandlers?.ommDownload) {
    const reqId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    void blob.arrayBuffer().then((buf) => {
      wk.webkit!.messageHandlers!.ommDownload!.postMessage({
        id: reqId,
        fileName,
        mimeType: blob.type || 'application/octet-stream',
        base64: uint8ToBase64(new Uint8Array(buf)),
      })
    })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
