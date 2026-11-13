/* ============================================================
 * OpenMindmap — lib/io/importers.ts
 * Nhập 4 định dạng: JSON native (v1/v2/v3), Markdown (MindMap-MD-1),
 * OPML (MindMap-OPML-1), TXT (MindMap-TXT-1) — SRS 14.1/14.6
 * Preflight → Parse → ImportedOutline → Preview → Tạo Project
 * ============================================================ */
import { ProjectDocV3, parseProjectJSON, uuid, newTopic, Topic, LIMITS } from '../core/types'
import { descendantsOf } from '../core/tree'

export type ImportFormat = 'json' | 'md' | 'opml' | 'txt'

export interface OutlineNode {
  text: string
  notes?: string | null
  checked?: boolean | null
  children: OutlineNode[]
}

export interface ImportPreview {
  format: ImportFormat
  fileName: string
  suggestedName: string
  roots: OutlineNode[]
  nodeCount: number
  maxDepth: number
  noteCount: number
  checkboxCount: number
  warnings: string[]
  lossReport: string[]
  nativeDoc?: ProjectDocV3 // JSON native: mở giữ ID hoặc nhập thành dự án mới
  synthesizedUpdatedAt?: boolean
  spaceWidth?: 2 | 4 | null // TXT dùng spaces
}

export function detectFormat(fileName: string, content: string): ImportFormat | null {
  const n = fileName.toLowerCase()
  if (n.endsWith('.json')) return 'json'
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'md'
  if (n.endsWith('.opml')) return 'opml'
  if (n.endsWith('.txt')) return 'txt'
  // theo nội dung
  const head = content.slice(0, 500).trim()
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  if (head.startsWith('<?xml') || head.startsWith('<opml')) return 'opml'
  if (/^#{1,6}\s|^\s*[-*+]\s/m.test(head)) return 'md'
  return null
}

function countOutline(roots: OutlineNode[]): { nodeCount: number; maxDepth: number; noteCount: number; checkboxCount: number } {
  let nodeCount = 0, maxDepth = 0, noteCount = 0, checkboxCount = 0
  const walk = (n: OutlineNode, d: number) => {
    nodeCount++
    maxDepth = Math.max(maxDepth, d)
    if (n.notes) noteCount++
    if (n.checked !== null && n.checked !== undefined) checkboxCount++
    n.children.forEach((c) => walk(c, d + 1))
  }
  roots.forEach((r) => walk(r, 0))
  return { nodeCount, maxDepth, noteCount, checkboxCount }
}

/* ---------------- JSON ---------------- */
function jsonToOutline(doc: ProjectDocV3): OutlineNode[] {
  const byParent = new Map<string | null, Topic[]>()
  doc.topics.forEach((t) => {
    const key = t.parent_id
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(t)
  })
  const walk = (pid: string | null): OutlineNode[] =>
    (byParent.get(pid) ?? []).sort((a, b) => a.order - b.order).map((t) => ({
      text: t.text,
      notes: t.notes ?? null,
      checked: t.checkbox ?? null,
      children: walk(t.id),
    }))
  return walk(null)
}

/* ---------------- Markdown — MindMap-MD-1 ---------------- */
export function parseMarkdown(text: string): { roots: OutlineNode[]; warnings: string[] } {
  const warnings: string[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const roots: OutlineNode[] = []
  interface Frame { node: OutlineNode; indent: number; headingLevel: number }
  let stack: Frame[] = []
  let noteCapture: { path: string; lines: string[] } | null = null
  const noteMap = new Map<string, string>()

  // Lượt 1: gom nội dung note marker
  const joined = lines.join('\n')
  const noteRe = /<!--\s*mindmap-note:start\s+topic-path="([^"]*)"\s*-->\n?([\s\S]*?)<!--\s*mindmap-note:end\s*-->/g
  let m: RegExpExecArray | null
  while ((m = noteRe.exec(joined)) !== null) {
    // Dedent khối note: cắt min-indent của các dòng không rỗng (dấu cách;
    // dòng tab giữ nguyên). Trước đây giữ nguyên thụt lề => roundtrip xuất→nhập
    // cộng dồn khoảng trắng ("Note" => "  Note\n  "). Giữ thụt lề tương đối.
    noteMap.set(m[1], dedentNote(m[2]))
  }
  if (noteMap.size) warnings.push(`Đã nhận ${noteMap.size} ghi chú theo marker mindmap-note (MindMap-MD-1).`)

  const pathOf = new Map<OutlineNode, string>() // topic-path theo vị trí duyệt
  const assignPaths = () => {
    roots.forEach((r, ri) => {
      pathOf.set(r, String(ri))
      const walk = (n: OutlineNode, p: string) => n.children.forEach((c, ci) => { pathOf.set(c, `${p}.${ci}`); walk(c, `${p}.${ci}`) })
      walk(r, String(ri))
    })
  }

  const stripCheckbox = (s: string): { text: string; checked: boolean | null } => {
    const mm = s.match(/^\[([ xX])\]\s*(.*)$/)
    if (mm) return { text: mm[2], checked: mm[1].toLowerCase() === 'x' }
    return { text: s, checked: null }
  }

  const withoutNotes = joined.replace(noteRe, '')

  for (const rawLine of withoutNotes.split('\n')) {
    const line = rawLine.replace(/\t/g, '    ')
    if (!line.trim()) continue
    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      const level = hm[1].length
      const node: OutlineNode = { text: hm[2].trim(), notes: null, checked: null, children: [] }
      if (level === 1) {
        roots.push(node)
        stack = [{ node, indent: -1, headingLevel: 1 }]
      } else {
        // heading cấp sâu hơn: về đúng mốc heading trước đó.
        // Pop cả bullet (headingLevel 0) lẫn heading cùng cấp/trên cấp — heading
        // sau một danh sách bullet phải quay về cha là heading cấp nhỏ hơn.
        while (stack.length > 1 && (stack[stack.length - 1].headingLevel === 0 || stack[stack.length - 1].headingLevel >= level)) stack.pop()
        if (!stack.length) { roots.push(node); stack = [{ node, indent: -1, headingLevel: level }] }
        else {
          const parent = stack[stack.length - 1].node
          parent.children.push(node)
          stack.push({ node, indent: -1, headingLevel: level })
        }
      }
      continue
    }
    const lm = line.match(/^(\s*)[-*+]\s+(.*)$/)
    if (lm) {
      const indent = lm[1].length
      const { text, checked } = stripCheckbox(lm[2].trim())
      const node: OutlineNode = { text, notes: null, checked, children: [] }
      while (stack.length && (stack[stack.length - 1].indent >= indent || (stack[stack.length - 1].headingLevel > 0 && stack[stack.length - 1].indent === -1 && stack.length > 1 && stack[stack.length - 1].indent >= indent))) {
        if (stack[stack.length - 1].indent === -1 && stack[stack.length - 1].headingLevel === 1) break
        if (stack[stack.length - 1].indent < indent) break
        stack.pop()
      }
      if (!stack.length) { roots.push(node); stack = [{ node, indent, headingLevel: 0 }] }
      else {
        stack[stack.length - 1].node.children.push(node)
        stack.push({ node, indent, headingLevel: 0 })
      }
    }
    // văn bản trôi không thuộc grammar → bỏ qua với warning nếu đáng kể
  }
  if (!roots.length && withoutNotes.trim()) {
    // Không H1/list → cả file là 1 node duy nhất
    roots.push({ text: text.trim().slice(0, 200), notes: null, checked: null, children: [] })
    warnings.push('Không thấy heading/bullet — toàn bộ nội dung thành một node.')
  }
  assignPaths()
  // gắn notes theo path
  const applyNotes = (n: OutlineNode) => {
    const p = pathOf.get(n)
    if (p && noteMap.has(p)) n.notes = noteMap.get(p)!
    n.children.forEach(applyNotes)
  }
  roots.forEach(applyNotes)
  return { roots, warnings }
}

/* Dedent khối ghi chú Markdown: cắt min-indent của các dòng không rỗng
 * (chỉ đếm dấu cách; dòng tab giữ nguyên), bỏ dòng rỗng đầu/cuối, giữ
 * dòng rỗng ở giữa và thụt lề tương đối bên trong. */
function dedentNote(raw: string): string {
  const rows = raw.split('\n')
  let min = Infinity
  for (const line of rows) {
    if (!line.trim()) continue
    if (line.startsWith('\t')) continue // dòng tab: không tính indent
    let n = 0
    while (n < line.length && line[n] === ' ') n++
    if (n < min) min = n
  }
  if (!isFinite(min) || min <= 0) {
    const rowsT = rows.slice()
    while (rowsT.length && !rowsT[0].trim()) rowsT.shift()
    while (rowsT.length && !rowsT[rowsT.length - 1].trim()) rowsT.pop()
    return rowsT.join('\n')
  }
  const out = rows
    .map((line) => (line.trim() && !line.startsWith('\t') ? line.slice(min) : line))
  while (out.length && !out[0].trim()) out.shift()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n')
}

/* ---------------- OPML — MindMap-OPML-1 ---------------- */
function stripXmlCommentsAndCdata(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
}

export function parseOPML(text: string): { roots: OutlineNode[]; warnings: string[] } {
  const warnings: string[] = []
  const sanitizedForDtdScan = stripXmlCommentsAndCdata(text)
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(sanitizedForDtdScan)) {
    throw new Error('OPML chứa DOCTYPE/ENTITY — bị chặn vì lý do bảo mật (XML external entity).')
  }
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error(`XML không hợp lệ: ${err.textContent?.slice(0, 200)}`)
  const body = doc.querySelector('body')
  if (!body) throw new Error('OPML thiếu <body>.')
  const walk = (el: Element): OutlineNode | null => {
    const text = el.getAttribute('text') ?? el.getAttribute('title') ?? ''
    const notes = el.getAttribute('_note') ?? null
    const checkedRaw = el.getAttribute('isChecked')
    const checked = checkedRaw === null ? null : checkedRaw === 'true'
    const node: OutlineNode = { text, notes, checked, children: [] }
    for (const child of Array.from(el.children)) {
      if (child.tagName.toLowerCase() === 'outline') {
        const c = walk(child)
        if (c) node.children.push(c)
      }
    }
    return node
  }
  const roots: OutlineNode[] = []
  for (const child of Array.from(body.children)) {
    if (child.tagName.toLowerCase() === 'outline') {
      const n = walk(child)
      if (n) roots.push(n)
    }
  }
  if (!roots.length) warnings.push('OPML không có outline nào ở cấp ngoài cùng.')
  return { roots, warnings }
}

/* ---------------- TXT — MindMap-TXT-1 ---------------- */
export function parseTXT(text: string, spaceWidth: 2 | 4 | null): { roots: OutlineNode[]; warnings: string[]; spaceWidth: 2 | 4 | null } {
  const warnings: string[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const decode = (s: string) => s.replace(/\\\\/g, '\x00').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\x00/g, '\\')
  const roots: OutlineNode[] = []
  let hasTabs = false, hasSpaces = false
  for (const l of lines) {
    if (!l.trim()) continue
    const ind = l.match(/^[\t ]*/)![0]
    if (ind.includes('\t')) hasTabs = true
    if (ind.includes(' ')) hasSpaces = true
  }
  let effSpace = spaceWidth
  if (!hasTabs && hasSpaces && !spaceWidth) {
    effSpace = 4 // tạm 4, UI cho chọn lại 2
    warnings.push('Tệp dùng khoảng trắng để thụt — hãy xác nhận chuẩn 2 hoặc 4 trong khung xem trước.')
  }
  if (hasTabs && hasSpaces) warnings.push('Tệp lẫn Tab và khoảng trắng — ưu tiên Tab.')
  const depthOf = (l: string): number => {
    const ind = l.match(/^[\t ]*/)![0]
    if (ind.includes('\t')) return ind.split('\t').length - 1
    if (!ind) return 0
    const w = effSpace ?? 4
    return Math.round(ind.length / w)
  }
  interface Frame { node: OutlineNode; depth: number }
  const stack: Frame[] = []
  let lastDepth = -1
  for (const l of lines) {
    if (!l.trim()) continue
    const depth = depthOf(l)
    if (depth > lastDepth + 1 && stack.length) {
      warnings.push(`Dòng "${l.trim().slice(0, 40)}" nhảy cấp quá 1 — đã gắn vào cấp gần nhất.`)
    }
    const node: OutlineNode = { text: decode(l.trim()), notes: null, checked: null, children: [] }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    if (!stack.length) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ node, depth })
    lastDepth = depth
  }
  return { roots, warnings, spaceWidth: effSpace }
}

/** With an unknown format, enforce the largest supported limit before sniffing. */
export function assertImportSize(bytes: number, format: ImportFormat | null): void {
  const limit = format === null || format === 'json' ? LIMITS.jsonBytes : LIMITS.textBytes
  if (bytes > limit) throw new Error(`Tệp quá lớn (${(bytes / 1048576).toFixed(1)} MB > ${limit / 1048576} MB).`)
}

/* ---------------- Điểm vào chính ---------------- */
export function buildImportPreview(fileName: string, content: string, spaceWidth: 2 | 4 | null = null): ImportPreview {
  const format = detectFormat(fileName, content)
  assertImportSize(new Blob([content]).size, format)
  if (!format) throw new Error('Định dạng không hỗ trợ. Chỉ nhập được .mindmap.json / .json / .md / .opml / .txt')
  const baseName = fileName.replace(/(?:\.mindmap)?\.[^.]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Dự án nhập'
  const preview: ImportPreview = {
    format,
    fileName,
    suggestedName: baseName,
    roots: [],
    nodeCount: 0, maxDepth: 0, noteCount: 0, checkboxCount: 0,
    warnings: [], lossReport: [],
    spaceWidth: null,
  }
  if (format === 'json') {
    const { doc, report, synthesizedUpdatedAt } = parseProjectJSON(content)
    preview.nativeDoc = doc
    preview.synthesizedUpdatedAt = synthesizedUpdatedAt
    preview.roots = jsonToOutline(doc)
    preview.warnings = [...report.warnings]
    if (report.remapped.length) preview.warnings.push(`Migration: ${report.remapped.slice(0, 5).join('; ')}`)
    preview.lossReport.push('Undo history cũ và viewport session không được khôi phục (theo hợp đồng định dạng).')
  } else if (format === 'md') {
    const { roots, warnings } = parseMarkdown(content)
    preview.roots = roots
    preview.warnings = warnings
    preview.lossReport.push('Mất: tọa độ, style, hình khối, nét vẽ, crosslink, ảnh, theme.')
  } else if (format === 'opml') {
    const { roots, warnings } = parseOPML(content)
    preview.roots = roots
    preview.warnings = warnings
    preview.lossReport.push('Mất: free-form tọa độ, style, drawing, crosslink (ngoài profile).')
  } else {
    const { roots, warnings, spaceWidth: eff } = parseTXT(content, spaceWidth)
    preview.roots = roots
    preview.warnings = warnings
    preview.spaceWidth = eff
    preview.lossReport.push('Mất: notes, style, checkbox, drawing, liên kết, ngày.')
  }
  const c = countOutline(preview.roots)
  Object.assign(preview, c)
  if (c.nodeCount === 0) throw new Error('Tệp không có chủ đề nào để nhập. Hãy kiểm tra nội dung tệp (OPML/TXT/Markdown) rồi thử lại.')
  if (c.nodeCount > LIMITS.nodes) throw new Error(`Số node (${c.nodeCount}) vượt giới hạn ${LIMITS.nodes}.`)
  if (c.maxDepth >= LIMITS.depth) throw new Error(`Độ sâu (${c.maxDepth}) vượt giới hạn ${LIMITS.depth}.`)
  return preview
}

/** OutlineNode[] → Topics cho project mới (root đầu = Central, sau = Floating) */
export function outlineToTopics(roots: OutlineNode[]): { topics: Topic[]; centralId: string } {
  if (!roots.length) throw new Error('Tệp không có chủ đề nào để tạo dự án.')
  const topics: Topic[] = []
  let centralId = ''
  const walk = (n: OutlineNode, parentId: string | null, role: Topic['role'], order: number): string => {
    const id = uuid()
    const t = newTopic({
      id, role, parent_id: parentId, order,
      text: n.text || 'Chủ đề',
      notes: n.notes ?? null,
      checkbox: n.checked === null || n.checked === undefined ? null : n.checked,
    })
    topics.push(t)
    if (!parentId && !centralId && role === 'central') centralId = id
    n.children.forEach((c, i) => walk(c, id, 'normal', i))
    return id
  }
  roots.forEach((r, i) => walk(r, null, i === 0 ? 'central' : 'floating', i))
  return { topics, centralId }
}

/** Nhập-as-new JSON: remap toàn bộ ID (14.6.4) */
export function remapProject(doc: ProjectDocV3): ProjectDocV3 {
  const idMap = new Map<string, string>()
  const remapped: Topic[] = doc.topics.map((t) => {
    const nid = uuid()
    idMap.set(t.id, nid)
    return { ...structuredClone(t), id: nid }
  })
  remapped.forEach((t) => {
    if (t.parent_id && idMap.has(t.parent_id)) t.parent_id = idMap.get(t.parent_id)!
    else if (t.parent_id) t.parent_id = null
  })
  const centralId = idMap.get(doc.central_topic_id) ?? remapped[0]?.id ?? uuid()
  return {
    ...structuredClone(doc),
    project_id: uuid(),
    central_topic_id: centralId,
    topics: remapped,
    crosslinks: doc.crosslinks
      .map((c) => ({ ...structuredClone(c), id: uuid(), source: idMap.get(c.source) ?? '', target: idMap.get(c.target) ?? '' }))
      .filter((c) => c.source && c.target),
    drawings: structuredClone(doc.drawings),
    assets: structuredClone(doc.assets),
  }
}
