/* ============================================================
 * OpenMindmap — components/Inspector.tsx
 * Inspector theo ngữ cảnh (SRS 03): Không chọn → Canvas/Layout/Theme;
 * 1 Node → Nội dung/Chữ/Hình khối/Nhánh/Ảnh và biểu tượng; Multi → Mixed;
 * Crosslink / Drawing riêng. Chỉ commit trường người dùng đụng tới.
 * ============================================================ */
'use client'
import { readImage } from '../lib/io/images'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../lib/store'
import { DEFAULT_TOPIC_FONT, resolveStyle } from '../lib/core/style'
import { buildScene } from '../lib/scene/scene'
import { getTopic, childrenOf, descendantsOf } from '../lib/core/tree'
import { NodePropsPatch } from '../lib/core/commands'
import { embeddedBitmap, PROJECT_THEMES, LAYOUT_DEFAULTS, LayoutKind, NumberingFormat, ImagePlacement, WeightKind } from '../lib/core/types'
import { NumberInput, SelectField, ToggleField, Segmented, ColorField, SliderField, Field, Row, TextInput, IconBtn, Divider } from './ui-bits'
import { NODE_ICONS } from '../lib/scene/icons'
import { cmdBuilders } from '../lib/core/commands'
import { CanvasIcon, TextIcon, SquareIcon, GitBranchIcon, PaperclipIcon, LayoutIcon, PaletteIcon, Grid3X3 } from './inspector-icons'
import { CloseIcon } from './ui-icons'

function SectionTitle({ title, first }: { title: string; first?: boolean }) {
  return (
    <div className={`${first ? '' : 'mt-3 border-t border-[var(--border)] pt-3'} mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text3)]`}>
      {title}
    </div>
  )
}

export function Inspector() {
  const doc = useApp((s) => s.doc)
  const selection = useApp((s) => s.selection)
  const tab = useApp((s) => s.inspectorTab)
  const setInspector = useApp((s) => s.setInspector)

  const kind: 'none' | 'node' | 'nodes' | 'crosslink' | 'drawing' =
    !doc ? 'none'
    : selection.length === 0 ? 'none'
    : selection[0].startsWith('crosslink:') ? 'crosslink'
    : selection[0].startsWith('drawing:') ? 'drawing'
    : selection.length === 1 ? 'node' : 'nodes'

  const title = kind === 'node' ? 'Node' : kind === 'nodes' ? `${selection.length} node` : kind === 'crosslink' ? 'Đường nối' : kind === 'drawing' ? 'Nét vẽ' : 'Sơ đồ'

  const tabs: { id: string; label: string; icon?: React.ReactNode }[] =
    kind === 'node' ? [
      { id: 'content', label: 'Nội dung', icon: <CanvasIcon /> },
      { id: 'text', label: 'Chữ', icon: <TextIcon /> },
      { id: 'box', label: 'Hình khối', icon: <SquareIcon /> },
      { id: 'branch', label: 'Nhánh', icon: <GitBranchIcon /> },
      { id: 'attach', label: 'Ảnh và biểu tượng', icon: <PaperclipIcon /> },
    ]
    : kind === 'nodes' ? [
      { id: 'text', label: 'Chữ', icon: <TextIcon /> },
      { id: 'box', label: 'Hình khối', icon: <SquareIcon /> },
      { id: 'branch', label: 'Sắp xếp', icon: <GitBranchIcon /> },
    ]
    : kind === 'crosslink' ? [{ id: 'crosslink', label: 'Đường nối' }]
    : kind === 'drawing' ? [{ id: 'drawing', label: 'Nét vẽ' }]
    : [
      { id: 'canvas', label: 'Canvas', icon: <Grid3X3 /> },
      { id: 'layout', label: 'Bố cục', icon: <LayoutIcon /> },
      { id: 'theme', label: 'Chủ đề', icon: <PaletteIcon /> },
    ]

  const active = tab && tabs.some((t) => t.id === tab) ? tab : tabs[0].id

  if (!doc) return null

  const renderTabBtn = (t: (typeof tabs)[number]) => (
    <button key={t.id} type="button" aria-pressed={active === t.id} onClick={() => setInspector(true, t.id)}
      className={`flex h-7 w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2 text-[11.5px] font-medium transition-colors ${active === t.id ? 'bg-[var(--accent)] text-[var(--onAccent)] shadow-sm' : 'text-[var(--text2)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`}>
      {t.icon}<span className="truncate">{t.label}</span>
    </button>
  )

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]" aria-label="Inspector">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3.5 py-2.5">
        <span className="text-[12.5px] font-semibold text-[var(--text)]">Inspector · <span className="text-[var(--accent)]">{title}</span></span>
        <button type="button" onClick={() => setInspector(false)} className="grid h-6 w-6 place-items-center rounded text-[var(--text2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text)]" title="Đóng Inspector" aria-label="Đóng Inspector">
          <CloseIcon size={14} />
        </button>
      </div>
      {kind === 'node' ? (
        <div className="border-b border-[var(--border)] px-2.5 py-2">
          <div className="grid grid-cols-3 gap-1">{tabs.slice(0, 3).map(renderTabBtn)}</div>
          <div className="mt-1 grid grid-cols-2 gap-1">{tabs.slice(3).map(renderTabBtn)}</div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1 border-b border-[var(--border)] px-2.5 py-2">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-pressed={active === t.id} onClick={() => setInspector(true, t.id)}
              className={`flex h-7 shrink-0 whitespace-nowrap items-center gap-1 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors ${active === t.id ? 'bg-[var(--accent)] text-[var(--onAccent)] shadow-sm' : 'text-[var(--text2)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5" key={active + selection.join(',')}>
        {kind === 'node' && active === 'content' && <ContentTab id={selection[0]} />}
        {kind === 'node' && active === 'text' && <TextTab ids={selection} />}
        {kind === 'node' && active === 'box' && <BoxTab ids={selection} />}
        {kind === 'node' && active === 'branch' && <BranchTab id={selection[0]} />}
        {kind === 'node' && active === 'attach' && <AttachTab id={selection[0]} />}
        {kind === 'nodes' && active === 'text' && <TextTab ids={selection} />}
        {kind === 'nodes' && active === 'box' && <BoxTab ids={selection} />}
        {kind === 'nodes' && active === 'branch' && <ArrangeTab ids={selection} />}
        {kind === 'none' && active === 'canvas' && <CanvasTab />}
        {kind === 'none' && active === 'layout' && <LayoutTab />}
        {kind === 'none' && active === 'theme' && <ThemeTab />}
        {kind === 'crosslink' && <CrosslinkTab id={selection[0].slice('crosslink:'.length)} />}
        {kind === 'drawing' && <DrawingTab id={selection[0].slice('drawing:'.length)} />}
      </div>
    </aside>
  )
}

/* ---------------- Nội dung ---------------- */
function ContentTab({ id }: { id: string }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const startEdit = useApp((s) => s.startEdit)
  const editor = useApp((s) => s.editor)
  const t = getTopic(doc, id)
  const [notePreview, setNotePreview] = useState(false)
  // Commit-on-unmount: khi ContentTab unmount (đổi node/đổi tab/đóng Inspector)
  // textarea bị remove KHÔNG kịp blur (trình duyệt không bắn blur khi remove
  // element đang focus) => bản nháp note mất. Cleanup đọc state tươi và commit
  // nếu editor notes của CHÍNH node này còn mở. (Trước F-1, canvas textarea
  // từng giữ bản nháp một cách tình cờ — đã bỏ.)
  useEffect(() => () => {
    const st = useApp.getState()
    if (st.editor && st.editor.field === 'notes' && st.editor.nodeId === id) st.commitEdit()
  }, [id])
  if (!t) return null
  const editingNotes = editor?.nodeId === id && editor.field === 'notes'
  return (
    <div>
      <SectionTitle title="Tiêu đề và ghi chú" first />
      <Field label="Tiêu đề node">
        <div className="flex gap-1.5">
          <TextInput value={t.text} readOnly aria-label="Tiêu đề node" onFocus={() => startEdit(id, 'title')} />
          <IconBtn title="Sửa trực tiếp trên canvas (F2)" onClick={() => startEdit(id, 'title')}>✎</IconBtn>
        </div>
      </Field>
      <Field label={`Ghi chú (Markdown)${t.notes ? ' — có ghi chú' : ''}`}>
        {editingNotes ? (
          <div>
            <textarea
              autoFocus value={editor!.draft}
              aria-label="Nội dung ghi chú Markdown"
              onChange={(e) => useApp.getState().updateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Escape') { e.stopPropagation(); useApp.getState().cancelEdit() }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) useApp.getState().commitEdit()
              }}
              onBlur={e => {
                const input = e.currentTarget
                if (!useApp.getState().commitEdit()) requestAnimationFrame(() => { if (input.isConnected && !document.querySelector('[role=dialog],[role=menu]')) input.focus() })
              }}
              rows={7}
              className="w-full resize-y rounded-md border border-[var(--accent)] bg-[var(--bg)] p-2 text-[12.5px] text-[var(--text)]"
              placeholder="- **đậm**, *nghiêng*, [link](https://…), - danh sách"
            />
            <div className="mt-1 flex gap-1.5 text-[11px] text-[var(--text2)]">
              <span>Ctrl+Enter lưu · Esc hủy</span>
              <button type="button" className="ml-auto underline" onMouseDown={(e) => e.preventDefault()} onClick={() => setNotePreview(!notePreview)}>{notePreview ? 'Sửa' : 'Xem trước'}</button>
            </div>
            {notePreview && <MarkdownLite text={editor!.draft} />}
          </div>
        ) : (
          <div className="flex gap-1.5">
            <TextInput value={t.notes ? `${t.notes.slice(0, 40)}${t.notes.length > 40 ? '…' : ''}` : ''} readOnly aria-label="Xem trước ghi chú" placeholder="Chưa có ghi chú" onFocus={() => startEdit(id, 'notes')} />
            <IconBtn title="Sửa ghi chú" onClick={() => startEdit(id, 'notes')}>✎</IconBtn>
          </div>
        )}
      </Field>
      <SectionTitle title="Thông tin bổ sung" />
      <Field label="Checkbox">
        <Row>
          <ToggleField value={t.checkbox !== null && t.checkbox !== undefined} aria-label="Bật checkbox" onChange={(v) => dispatch({ type: 'setProps', id, before: { checkbox: t.checkbox }, after: { checkbox: v ? true : null } }, 'Checkbox')} />
          <span className="text-[11.5px] text-[var(--text2)]">{t.checkbox !== null && t.checkbox !== undefined ? 'Bật' : 'Tắt'}</span>
        </Row>
      </Field>
      <Field label="Ngày (ISO yyyy-mm-dd)">
        <TextInput type="date" aria-label="Ngày (ISO yyyy-mm-dd)" value={t.date ?? ''} onChange={(e) => dispatch({ type: 'setProps', id, before: { date: t.date }, after: { date: e.target.value || null } }, 'Đặt ngày')} />
      </Field>
      <Field label="Liên kết (http/https/mailto)">
        <UrlField url={t.url ?? null} onChange={(v) => dispatch({ type: 'setProps', id, before: { url: t.url }, after: { url: v } }, 'Liên kết')} />
        {t.url && /^(https?:|mailto:)/i.test(t.url) && <a href={t.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[11.5px] text-[var(--accent)] underline">Mở liên kết ↗</a>}
      </Field>
      <SectionTitle title="Đánh số" />
      <Field label="Đánh số nhánh con">
        <SelectField<NumberingFormat>
          value={(t.numbering?.format ?? 'none') as NumberingFormat}
          options={[
            { value: 'none', label: 'Không đánh số' },
            { value: 'decimal', label: '1. 2. 3.' },
            { value: 'dotted', label: '1.1, 1.2 (phân cấp)' },
            { value: 'alpha', label: 'A. B. C.' },
          ]}
          onChange={(v) => dispatch({ type: 'setProps', id, before: { numbering: t.numbering }, after: { numbering: v === 'none' ? null : { format: v, apply_to_subtree: true } } }, 'Đánh số')}
        />
      </Field>
    </div>
  )
}

/* Trường Liên kết: cho phép gõ tay từng ký tự — giá trị trung gian chưa hợp lệ
 * chỉ nằm trong draft (không commit sai — 03.4); commit khi Enter/blur hợp lệ;
 * Esc hoàn nguyên. Trước đây controlled input từ chối mọi giá trị trung gian
 * ('h', 'ht', …) => gõ tay bất khả thi. */
function UrlField({ url, onChange }: { url: string | null; onChange: (v: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelBlur = useRef(false)
  const shown = draft ?? (url ?? '')
  const commit = () => {
    if (cancelBlur.current || draft === null) return
    setDraft(null)
    const v = draft.trim() || null
    if (v && !/^(https?:\/\/|mailto:)/i.test(v)) return // không hợp lệ: bỏ draft, giữ giá trị cũ
    if ((v ?? null) !== (url ?? null)) onChange(v)
  }
  return (
    <TextInput
      value={shown}
      placeholder="https://…"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
        if (e.key === 'Escape') { e.stopPropagation(); cancelBlur.current = true; setDraft(null); e.currentTarget.blur(); cancelBlur.current = false }
      }}
    />
  )
}

function MarkdownLite({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*.+?\*\*|\*.+?\*|\[.+?\]\(https?:[^)]+\))/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <b key={index}>{part.slice(2, -2)}</b>
    if (part.startsWith('*') && part.endsWith('*')) return <i key={index}>{part.slice(1, -1)}</i>
    const match = part.match(/^\[(.+?)\]\((https?:[^)]+)\)$/)
    if (match) {
      try {
        const url = new URL(match[2])
        if (url.protocol === 'http:' || url.protocol === 'https:') return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">{match[1]}</a>
      } catch { /* Keep malformed links as text. */ }
    }
    return part
  })
  return <div className="mt-1.5 rounded-md border border-[var(--border)] p-2 text-[12px] leading-relaxed text-[var(--text)]">{text.split('\n').map((line, index) => <React.Fragment key={index}>{index > 0 && <br />}{inline(line.startsWith('- ') ? `• ${line.slice(2)}` : line)}</React.Fragment>)}</div>
}

/* ---------------- Chữ (05) ---------------- */
function TextTab({ ids }: { ids: string[] }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const first = getTopic(doc, ids[0])
  if (!first) return null
  const st = first.style.text ?? {}
  const mixed = <T,>(vals: T[]): T | '—' => (ids.length > 1 && new Set(vals.map(String)).size > 1 ? '—' as const : vals[0])
  const all = ids.map((i) => getTopic(doc, i)!).filter(Boolean)
  const val = <K extends keyof typeof st>(k: K, def: NonNullable<typeof st[K]>): NonNullable<typeof st[K]> | '—' =>
    mixed(all.map((t) => (t.style.text?.[k] ?? def) as NonNullable<typeof st[K]>))
  const resolved = all.map(topic => resolveStyle(doc, topic).text)
  const fontSize = mixed(resolved.map(style => style.fontSizePt))
  const fontFamily = mixed(resolved.map(style => style.fontFamily))
  const fontWeight = mixed(resolved.map(style => style.fontWeight))
  const italic = mixed(resolved.map(style => style.italic))
  const underline = mixed(resolved.map(style => style.underline))
  const strike = mixed(resolved.map(style => style.strike))
  const textColorMixed = ids.length > 1 && new Set(resolved.map(style => style.color)).size > 1
  const textColorOverride = ids.length > 1 && new Set(all.map(t => t.style.text?.color ?? null)).size > 1 ? null : (st.color ?? null)
  const hAlign = mixed(resolved.map(style => style.hAlign))
  const vAlign = mixed(resolved.map(style => style.vAlign))
  const lineHeight = mixed(resolved.map(style => style.lineHeight))
  const paragraphGap = mixed(resolved.map(style => style.paragraphGap))
  const wrap = mixed(resolved.map(style => style.wrap))
  const wrapWidth = mixed(resolved.map(style => style.wrapWidth))
  const fontOptions = [
    { value: 'Noto Sans, ui-sans-serif, system-ui', label: 'Noto Sans (mặc định)' },
    { value: 'Inter, ui-sans-serif, system-ui', label: 'Inter' },
    { value: '"Segoe UI", system-ui', label: 'Segoe UI' },
    { value: 'Roboto, system-ui', label: 'Roboto' },
    { value: 'Georgia, serif', label: 'Georgia' },
    { value: '"Times New Roman", serif', label: 'Times New Roman' },
    { value: '"Courier New", monospace', label: 'Courier New' },
  ]
  const fontChoice = fontFamily === DEFAULT_TOPIC_FONT ? fontOptions[0].value : fontFamily
  if (fontChoice !== '—' && !fontOptions.some(option => option.value === fontChoice)) {
    // Display the resolved value of documents with an existing font outside the presets.
    fontOptions.unshift({ value: fontChoice, label: fontChoice })
  }
  const adjustFont = (delta: number) => {
    const commands = all.flatMap(topic => {
      const size = resolveStyle(doc, topic).text.fontSizePt
      const next = Math.max(8, Math.min(72, size + delta))
      return next === size ? [] : [{ type: 'setTextStyle' as const, ids: [topic.id], before: {}, after: { font_size_pt: next } }]
    })
    if (commands.length) dispatch({ type: 'composite', commands }, 'Cỡ chữ')
  }
  const setStyle = (patch: Record<string, unknown>, label: string) =>
    dispatch({ type: 'setTextStyle', ids, before: {}, after: patch as never }, label)

  return (
    <div>
      <SectionTitle title="Phông và cỡ" first />
      <Field label="Phông chữ">
        <SelectField value={fontChoice}
          options={fontOptions}
          onChange={(v) => setStyle({ font_family: v }, 'Đổi phông')}
        />
      </Field>
      <Field label={`Cỡ chữ (8–72 pt)${typeof val('font_size_pt', 14) === 'number' && ids.length === 1 && first.parent_id === doc.central_topic_id && st.font_size_pt === undefined ? ' — kế thừa 17 pt cấp 1' : ''}`}>
        <Row>
          <NumberInput value={typeof fontSize === 'number' ? fontSize : null} min={8} max={72} unit="pt" aria-label="Cỡ chữ (pt)" onCommit={(v) => v !== null && setStyle({ font_size_pt: v }, 'Cỡ chữ')} />
          <IconBtn title="Giảm 1pt" aria-label="Giảm cỡ chữ 1pt" onClick={() => adjustFont(-1)}>−</IconBtn>
          <IconBtn title="Tăng 1pt" aria-label="Tăng cỡ chữ 1pt" onClick={() => adjustFont(1)}>+</IconBtn>
        </Row>
      </Field>
      <SectionTitle title="Kiểu và màu chữ" />
      <Field label="Độ đậm">
        <Segmented value={String(fontWeight)}
          options={[{ value: '400', label: 'Regular' }, { value: '500', label: 'Medium' }, { value: '600', label: 'Semibold' }, { value: '700', label: 'Bold' }]}
          onChange={(v) => setStyle({ font_weight: Number(v) }, 'Độ đậm')}
        />
      </Field>
      <Field label="Kiểu nhấn mạnh và màu chữ">
        <Row>
          <IconBtn active={italic === true} title="Nghiêng toàn bộ tiêu đề" onClick={() => setStyle({ italic: !(italic === true) }, 'Nghiêng')}><b><i>I</i></b></IconBtn>
          <IconBtn active={underline === true} title="Gạch dưới" onClick={() => setStyle({ underline: !(underline === true) }, 'Gạch dưới')}><u>U</u></IconBtn>
          <IconBtn active={strike === true} title="Gạch ngang" onClick={() => setStyle({ strike: !(strike === true) }, 'Gạch ngang')}><s>S</s></IconBtn>
          <Divider />
          <ColorField value={textColorOverride} mixed={textColorMixed} aria-label="Màu chữ" onCommit={(c) => setStyle({ color: c }, 'Màu chữ')} hint="Màu chữ (#RRGGBB)" />
        </Row>
      </Field>
      <SectionTitle title="Căn chỉnh" />
      <Field label="Căn chữ trong node">
        <Row className="flex-wrap">
          <Segmented value={String(hAlign)} aria-label="Căn ngang"
            options={[
              { value: 'left', label: 'Trái', ariaLabel: 'Căn ngang — Trái' },
              { value: 'center', label: 'Giữa', ariaLabel: 'Căn ngang — Giữa' },
              { value: 'right', label: 'Phải', ariaLabel: 'Căn ngang — Phải' },
            ]}
            onChange={(v) => setStyle({ horizontal_align: v }, 'Căn ngang')} />
          <Segmented value={String(vAlign)} aria-label="Căn dọc"
            options={[
              { value: 'top', label: 'Trên', ariaLabel: 'Căn dọc — Trên' },
              { value: 'middle', label: 'Giữa', ariaLabel: 'Căn dọc — Giữa' },
              { value: 'bottom', label: 'Dưới', ariaLabel: 'Căn dọc — Dưới' },
            ]}
            onChange={(v) => setStyle({ vertical_align: v }, 'Căn dọc')} />
        </Row>
      </Field>
      <SectionTitle title="Khoảng cách và lề" />
      <Field label="Giãn dòng (1.0–2.0)">
        <SliderField value={typeof lineHeight === 'number' ? lineHeight : 1.2} min={1} max={2} step={0.05} onCommit={(v) => setStyle({ line_height_multiplier: v }, 'Giãn dòng')} format={(v) => v.toFixed(2)} />
      </Field>
      <Field label="Khoảng đoạn (0–32 world)">
        <NumberInput value={typeof paragraphGap === 'number' ? paragraphGap : null} min={0} max={32} onCommit={(v) => v !== null && setStyle({ paragraph_gap_world: v }, 'Khoảng đoạn')} />
      </Field>
      <Field label="Wrap" hint="Khi để trống: node Auto tự nở ngang theo cỡ chữ; node Cố định dùng trọn bề rộng khung. Khi đặt giá trị (80–800): giới hạn chiều ngang dòng chữ trước khi xuống dòng.">
        <Row>
          <ToggleField value={wrap === '—' ? null : wrap} mixed={wrap === '—'} aria-label="Bật tự động xuống dòng" onChange={(v) => setStyle({ wrap: v }, 'Wrap')} />
          <NumberInput value={typeof wrapWidth === 'number' ? wrapWidth : null} min={80} max={800} unit="world" aria-label="Bề rộng wrap (world) — để trống để tự tính theo kích thước node" disabled={wrap === false} onCommit={(v) => v !== null && setStyle({ wrap_width_world: v }, 'Bề rộng wrap')} />
        </Row>
      </Field>
      <Field label="Lề trong T/R/B/D (0–64 world)">
        {(() => {
          const sideValues = ([0, 1, 2, 3] as const).map((i) => {
            const vals = resolved.map((r) => r.padding[i])
            return ids.length > 1 && new Set(vals).size > 1 ? null : vals[0]
          })
          const sideLabels = ['Lề trên', 'Lề phải', 'Lề dưới', 'Lề trái'] as const
          return (
            <Row>
              {(['T', 'R', 'B', 'L'] as const).map((side, i) => (
                <NumberInput key={side} value={sideValues[i]} min={0} max={64} width="52px" aria-label={sideLabels[i]} onCommit={(v) => {
                  if (v === null) return
                  const perTopic: Record<string, { padding_world: [number, number, number, number] }> = {}
                  for (let k = 0; k < all.length; k++) {
                    const topic = all[k]
                    const next = [...resolved[k].padding] as [number, number, number, number]
                    next[i] = v
                    perTopic[topic.id] = { padding_world: next }
                  }
                  dispatch({ type: 'setTextStyle', ids, before: {}, after: {}, perTopic }, `Lề trong ${side}`)
                }} />
              ))}
            </Row>
          )
        })()}
      </Field>
      <button type="button" onClick={() => dispatch({ type: 'resetNodeStyle', scope: 'text', ids, before: {} }, 'Đặt lại phần chữ')} className="mt-1 w-full rounded-md border border-[var(--border)] py-1.5 text-[12px] text-[var(--text2)] hover:bg-[var(--hover)]">Đặt lại phần chữ (kế thừa)</button>
    </div>
  )
}

/* ---------------- Hình khối (06.1) ---------------- */
function BoxTab({ ids }: { ids: string[] }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const first = getTopic(doc, ids[0])
  if (!first) return null
  const effective = buildScene(doc).byId.get(first.id)?.box
  const st = first.style.box_style ?? {}
  const resolvedBox = resolveStyle(doc, first).box
  const all = ids.map((i) => getTopic(doc, i)!).filter(Boolean)
  const resolvedBoxes = all.map(topic => resolveStyle(doc, topic).box)
  const mixedVal = <T,>(vals: T[]): T | '—' => (ids.length > 1 && new Set(vals.map(String)).size > 1 ? '—' as const : vals[0])
  const shape = mixedVal(resolvedBoxes.map(value => value.shape))
  const sizeMode = mixedVal(resolvedBoxes.map(value => value.sizeMode))
  const anyFixed = resolvedBoxes.some(value => value.sizeMode === 'fixed')
  const fixedWidths = resolvedBoxes.map(value => value.width ?? 160)
  const fixedHeights = resolvedBoxes.map(value => value.height ?? 60)
  const widthVal = mixedVal(fixedWidths)
  const heightVal = mixedVal(fixedHeights)
  const corner = mixedVal(resolvedBoxes.map(value => value.cornerRadius))
  const fillMixed = ids.length > 1 && new Set(resolvedBoxes.map(value => value.fill)).size > 1
  const fillOverride = ids.length > 1 && new Set(all.map(t => t.style.box_style?.fill ?? null)).size > 1 ? null : (st.fill ?? null)
  const strokeMixed = ids.length > 1 && new Set(resolvedBoxes.map(value => value.stroke)).size > 1
  const strokeOverride = ids.length > 1 && new Set(all.map(t => t.style.box_style?.stroke ?? null)).size > 1 ? null : (st.stroke ?? null)
  const strokeWidth = mixedVal(resolvedBoxes.map(value => value.strokeWidth))
  const strokeDash = mixedVal(resolvedBoxes.map(value => value.dash))
  const shadow = mixedVal(resolvedBoxes.map(value => value.shadow))
  const setBox = (patch: Record<string, unknown>, label: string) =>
    dispatch({ type: 'setBoxStyle', ids, before: {}, after: patch as never }, label)
  return (
    <div>
      <SectionTitle title="Hình dạng và kích thước" first />
      <Field label="Hình dạng">
        <Segmented value={shape}
          options={[{ value: 'rect', label: 'Vuông' }, { value: 'rounded', label: 'Bo góc' }, { value: 'pill', label: 'Viên thuốc' }]}
          onChange={(v) => setBox({ shape: v }, 'Hình dạng')} />
        {shape === '—' && <span className="text-[11.5px] text-[var(--text2)]" aria-label="Nhiều hình dạng">—</span>}
      </Field>
      <Field label="Kích thước">
        <div className="flex flex-col items-start gap-2">
          <Segmented value={sizeMode} options={[{ value: 'auto', label: 'Auto' }, { value: 'fixed', label: 'Cố định' }]} onChange={(v) => setBox({ size_mode: v }, 'Chế độ kích thước')} />
          {sizeMode === '—' && <span className="text-[11.5px] text-[var(--text2)]" aria-label="Nhiều chế độ kích thước">—</span>}
          {anyFixed && (
            <Row>
              <NumberInput value={typeof widthVal === 'number' ? widthVal : null} min={32} max={1200} unit="w" aria-label="Bề rộng cố định" onCommit={(v) => v !== null && setBox({ width_world: v }, 'Bề rộng')} />
              <NumberInput value={typeof heightVal === 'number' ? heightVal : null} min={24} max={800} unit="h" aria-label="Bề cao cố định" onCommit={(v) => v !== null && setBox({ height_world: v }, 'Bề cao')} />
            </Row>
          )}
          {ids.length === 1 && resolvedBox.sizeMode === 'fixed' && effective && (effective.w > (resolvedBox.width ?? 160) || effective.h > (resolvedBox.height ?? 60)) && (
            <span className="text-[11px] text-[var(--text2)]" role="status">Khung lưu {(resolvedBox.width ?? 160)} × {(resolvedBox.height ?? 60)}; hiển thị {effective.w} × {effective.h} để đủ nội dung. Dữ liệu chưa bị thay đổi.</span>
          )}
        </div>
      </Field>
      <SectionTitle title="Nền và bo góc" />
      <Field label="Bo góc (0–32)">
        <SliderField value={typeof corner === 'number' ? corner : resolvedBox.cornerRadius} min={0} max={32} onCommit={(v) => setBox({ corner_radius_world: v }, 'Bo góc')} />
        {corner === '—' && <span className="text-[11.5px] text-[var(--text2)]" aria-label="Nhiều giá trị bo góc">—</span>}
      </Field>
      <Field label="Màu nền">
        <Row>
          <ColorField value={fillOverride} mixed={fillMixed} aria-label="Màu nền" onCommit={(c) => setBox({ fill: c }, 'Màu nền')} />
          <span className="text-[11px] text-[var(--text2)]">{fillMixed ? 'nhiều giá trị' : 'trống = kế thừa theme'}</span>
        </Row>
      </Field>
      <SectionTitle title="Viền và bóng" />
      <Field label="Viền">
        <Row>
          <ColorField value={strokeOverride} mixed={strokeMixed} aria-label="Màu viền" onCommit={(c) => setBox({ stroke: c }, 'Màu viền')} />
          <NumberInput value={typeof strokeWidth === 'number' ? strokeWidth : null} min={0} max={12} step={0.5} unit="w" aria-label="Độ dày viền" onCommit={(v) => v !== null && setBox({ stroke_width_world: v }, 'Độ dày viền')} />
        </Row>
      </Field>
      <Field label="Kiểu nét viền">
        <Segmented value={String(strokeDash)}
          options={[{ value: 'solid', label: 'Liền' }, { value: 'dashed', label: 'Đứt' }, { value: 'dotted', label: 'Chấm' }]}
          onChange={(v) => setBox({ stroke_dash: v }, 'Kiểu viền')} />
        {strokeDash === '—' && <span className="text-[11.5px] text-[var(--text2)]" aria-label="Nhiều kiểu nét viền">—</span>}
      </Field>
      <Field label="Đổ bóng">
        <Row>
          <ToggleField value={shadow === '—' ? null : shadow === 'soft'} mixed={shadow === '—'} aria-label="Bật đổ bóng" onChange={(v) => setBox({ shadow_preset: v ? 'soft' : 'none' }, 'Đổ bóng')} />
          <span className="text-[11.5px] text-[var(--text2)]">{shadow === '—' ? 'Nhiều giá trị (—)' : 'Soft shadow'}</span>
        </Row>
      </Field>
      <button type="button" onClick={() => dispatch({ type: 'resetNodeStyle', scope: 'box_style', ids, before: {} }, 'Đặt lại hình khối')} className="mt-1 w-full rounded-md border border-[var(--border)] py-1.5 text-[12px] text-[var(--text2)] hover:bg-[var(--hover)]">Đặt lại hình khối (kế thừa)</button>
    </div>
  )
}

/* ---------------- Nhánh (branch style) ---------------- */
function BranchTab({ id }: { id: string }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const t = getTopic(doc, id)
  if (!t) return null
  const b = t.branch_style_override ?? null
  const isCentral = doc.central_topic_id === id
  const hasKids = childrenOf(doc, id).length > 0
  return (
    <div>
      <SectionTitle title="Màu nhánh" first />
      <Field label="Màu nhánh (áp cho cả nhánh con — edge + accent)">
        <Row>
          <ColorField value={b?.accent_color ?? null} disabled={isCentral} aria-label="Màu nhánh" onCommit={(c) => dispatch({ type: 'setBranchStyle', id, before: b, after: { accent_color: c, edge_color: c } }, 'Màu nhánh')} hint={isCentral ? 'Chủ đề trung tâm không có màu nhánh' : undefined} />
        </Row>
      </Field>
      <Field label="Màu chữ nhánh con">
        <ColorField value={b?.text_color ?? null} disabled={isCentral} aria-label="Màu chữ nhánh con" onCommit={(c) => dispatch({ type: 'setBranchStyle', id, before: b, after: { text_color: c } }, 'Màu chữ nhánh')} />
      </Field>
      <SectionTitle title="Đường nối" />
      <Field label="Nét nối (edge)">
        <Row>
          <ColorField value={b?.edge_color ?? null} aria-label="Màu nét nối" onCommit={(c) => dispatch({ type: 'setBranchStyle', id, before: b, after: { edge_color: c } }, 'Màu nét nối')} />
          <NumberInput value={b?.edge_width_world ?? 2} min={0.5} max={12} step={0.5} aria-label="Độ dày nét nối" onCommit={(v) => v !== null && dispatch({ type: 'setBranchStyle', id, before: b, after: { edge_width_world: v } }, 'Độ dày nét nối')} />
        </Row>
      </Field>
      <Field label="Kiểu đường nối">
        <Segmented value={(b?.edge_routing ?? doc.layout.routing) as string}
          options={[{ value: 'curved', label: 'Cong' }, { value: 'straight', label: 'Thẳng' }, { value: 'elbow', label: 'Gãy' }]}
          onChange={(v) => dispatch({ type: 'setBranchStyle', id, before: b, after: { edge_routing: v as never } }, 'Kiểu nối')} />
      </Field>
      <SectionTitle title="Vị trí và sắp xếp" />
      <Field label="Bên nhánh (Balanced)">
        <Segmented value={t.branch_side as string}
          options={[{ value: 'auto', label: 'Tự động' }, { value: 'left', label: 'Trái' }, { value: 'right', label: 'Phải' }]}
          onChange={(v) => dispatch({ type: 'setProps', id, before: { branch_side: t.branch_side }, after: { branch_side: v as never } }, 'Bên nhánh')} />
      </Field>
      <SingleNodeArrange id={id} />
      <SectionTitle title="Thu gọn" />
      <Field label="Thu gọn nhánh">
        <Row>
          <ToggleField value={t.collapsed} aria-label="Thu gọn nhánh" onChange={(v) => dispatch({ type: 'collapse', items: [{ id, value: v }] }, 'Thu gọn')} disabled={!hasKids} />
          <span className="text-[11.5px] text-[var(--text2)]">{hasKids ? `${descendantsOf(doc, id).length} node con` : 'Không có node con'}</span>
        </Row>
      </Field>
      <button type="button" onClick={() => dispatch({ type: 'resetBranchStyle', id, before: b }, 'Đặt lại kiểu nhánh')} className="mt-1 w-full rounded-md border border-[var(--border)] py-1.5 text-[12px] text-[var(--text2)] hover:bg-[var(--hover)]">Đặt lại kiểu nhánh</button>
    </div>
  )
}

/* ---------------- Ảnh và biểu tượng (06.2/06.3) ---------------- */
function AttachTab({ id }: { id: string }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const toast = useApp((s) => s.toast)
  const t = getTopic(doc, id)
  if (!t) return null
  const img = t.image
  const asset = img ? doc.assets.find((a) => a.id === img.asset_id) : null
  const onFile = async (file: File) => {
    const generation = useApp.getState().generation
    try {
      const { asset, image } = await readImage(file)
      const current = useApp.getState()
      if (current.generation !== generation || !current.doc) return
      const node = getTopic(current.doc, id)
      if (!node) return
      dispatch({ type: 'attachImage', id, asset, before: node.image ?? null, after: image }, 'Gắn ảnh')
    } catch (e) { toast('error', 'Gắn ảnh thất bại', e instanceof Error ? e.message : String(e)) }
  }
  return (
    <div>
      <SectionTitle title="Ảnh đính kèm" first />
      <Field label="Tệp ảnh">
        <label className="flex h-9 cursor-pointer items-center justify-center rounded-md border border-dashed border-[var(--border)] text-[12px] text-[var(--text2)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
          {img ? 'Thay ảnh khác…' : '+ Chèn ảnh (PNG/JPEG/WebP/GIF ≤20MB)'}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Chọn tệp ảnh đính kèm" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
      </Field>
      {img && asset && !embeddedBitmap(asset.data_url) && <p className="text-[12px] text-[var(--danger)]">Ảnh đính kèm không hợp lệ.</p>}
      {img && asset && embeddedBitmap(asset.data_url) && (
        <>
          <div className="mb-2 overflow-hidden rounded-md border border-[var(--border)]">
            <img src={asset.data_url} alt="Ảnh đính kèm" className="max-h-32 w-full object-contain" />
            <div className="bg-[var(--bg)] px-2 py-1 text-[10.5px] text-[var(--text2)]">{asset.width}×{asset.height}px · {(asset.data_url.length * 0.75 / 1024).toFixed(0)} KB</div>
          </div>
          <Field label="Vị trí ảnh">
            <SelectField<ImagePlacement> value={img.placement} options={[
              { value: 'below', label: 'Dưới chữ' }, { value: 'above', label: 'Trên chữ' }, { value: 'left', label: 'Bên trái chữ' }, { value: 'right', label: 'Bên phải chữ' },
            ]} onChange={(v) => dispatch({ type: 'setProps', id, before: { image: img }, after: { image: { ...img, placement: v } } }, 'Vị trí ảnh')} />
          </Field>
          <Field label="Kích thước ảnh (phần trăm bề rộng)">
            <SliderField value={Math.round(img.width_fraction * 100)} min={10} max={100} onCommit={(v) => dispatch({ type: 'setProps', id, before: { image: img }, after: { image: { ...img, width_fraction: v / 100 } } }, 'Cỡ ảnh')} format={(v) => `${v}%`} />
          </Field>
          <Field label="Vừa khít">
            <Segmented value={img.fit} options={[{ value: 'contain', label: 'Contain' }, { value: 'cover', label: 'Cover' }]} onChange={(v) => dispatch({ type: 'setProps', id, before: { image: img }, after: { image: { ...img, fit: v } } }, 'Fit ảnh')} />
          </Field>
          <button type="button" onClick={() => dispatch({ type: 'removeImage', id, before: img }, 'Gỡ ảnh')} className="mb-2.5 w-full rounded-md border border-[var(--danger)] py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--dangerSoft)]">Gỡ ảnh khỏi node</button>
        </>
      )}
      <SectionTitle title="Biểu tượng" />
      <Field label="Biểu tượng icon">
        <Row className="flex-wrap">
          <SelectField aria-label="Chọn biểu tượng icon" value={(t.icon?.icon_id ?? '') as string}
            options={[{ value: '', label: 'Không icon' }, ...NODE_ICONS.map((i) => ({ value: i.id, label: i.name }))]}
            onChange={(v) => dispatch({ type: 'setProps', id, before: { icon: t.icon }, after: { icon: v ? { icon_id: v, size: t.icon?.size ?? 'm', position: 'before_title' } : null } }, 'Icon')} />
          {t.icon && (
            <Segmented aria-label="Cỡ biểu tượng icon" value={t.icon.size} options={[{ value: 's', label: 'S', ariaLabel: 'Cỡ nhỏ S' }, { value: 'm', label: 'M', ariaLabel: 'Cỡ vừa M' }, { value: 'l', label: 'L', ariaLabel: 'Cỡ lớn L' }]}
              onChange={(v) => dispatch({ type: 'setProps', id, before: { icon: t.icon }, after: { icon: { ...t.icon!, size: v as never } } }, 'Cỡ icon')} />
          )}
        </Row>
        {t.icon && <IconPreview id={t.icon.icon_id} />}
      </Field>
    </div>
  )
}
function IconPreview({ id }: { id: string }) {
  const icon = NODE_ICONS.find((i) => i.id === id)
  if (!icon) return null
  return (
    <svg width="22" height="22" className="mt-1"><path d={icon.path} fill="none" stroke="var(--text)" strokeWidth="2" transform="translate(0,0)" /></svg>
  )
}

/* ---------------- Sắp xếp (multi) ---------------- */
function ArrangeTab({ ids }: { ids: string[] }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  return (
    <div>
      <Field label="Căn chỉnh node (chỉ Free-form)">
        <Row className="flex-wrap">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} type="button" disabled={doc.layout.kind !== 'freeform'} aria-label={a === 'left' ? 'Căn trái các node' : a === 'center' ? 'Căn giữa các node' : 'Căn phải các node'} className="rounded border border-[var(--border)] px-2.5 py-1 text-[11.5px] hover:bg-[var(--hover)] disabled:opacity-40" onClick={() => {
              const scene = buildScene(doc)
              const boxes = ids.flatMap(id => {
                const box = scene.byId.get(id)?.box
                const position = scene.layoutResult.pos.get(id)
                return box && position ? [{ id, box, position }] : []
              })
              if (boxes.length < 2) return
              const edge = (b: typeof boxes[number]['box']) => b.x + (a === 'center' ? b.w / 2 : a === 'right' ? b.w : 0)
              const xs = boxes.map(({ box }) => edge(box))
              const ref = a === 'left' ? Math.min(...xs) : a === 'right' ? Math.max(...xs) : xs.reduce((sum, x) => sum + x, 0) / xs.length
              const items = boxes.flatMap(({ id, box, position }) => {
                const dx = ref - edge(box)
                return Math.abs(dx) < 0.001 ? [] : [{ id, from: position, to: { x: position.x + dx, y: position.y } }]
              })
              if (items.length) dispatch({ type: 'moveFreeform', items }, `Căn ${a}`)
            }}>{a === 'left' ? 'Căn trái' : a === 'center' ? 'Căn giữa' : 'Căn phải'}</button>
          ))}
        </Row>
      </Field>
      <Field label="Nhóm thao tác">
        <Row className="flex-wrap">
          <button disabled={!ids.length || ids[0] === doc.central_topic_id || getTopic(doc, ids[0])?.role === 'central'} className="rounded border border-[var(--border)] px-2 py-1 text-[11.5px] disabled:opacity-40" onClick={() => useApp.getState().duplicateSelection()}>Nhân bản nhánh đầu tiên</button>
          <button className="rounded border border-[var(--danger)] px-2 py-1 text-[11.5px] text-[var(--danger)]" onClick={() => useApp.getState().deleteSelection()}>Xóa tất cả đã chọn</button>
        </Row>
      </Field>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text2)]">Chỉnh nhiều node: chỉ trường bạn thực sự thay đổi được áp dụng cho tất cả; các trường khác nhau hiển thị “—”.</p>
    </div>
  )
}
function SingleNodeArrange({ id }: { id: string }) {
  const doc = useApp(s => s.doc)!
  const dispatch = useApp(s => s.dispatch)
  const commands = [
    ['Lên', cmdBuilders.reorderUpDown(doc, id, -1)],
    ['Xuống', cmdBuilders.reorderUpDown(doc, id, 1)],
    ['Lên cấp', cmdBuilders.promote(doc, id)],
    ['Xuống cấp', cmdBuilders.demote(doc, id)],
  ] as const
  return <Field label="Thứ tự trong siblings"><Row className="flex-wrap">
    {commands.map(([label, command]) => <button key={label} disabled={!command || id === doc.central_topic_id} className="rounded border border-[var(--border)] px-2 py-1 text-[11.5px] disabled:opacity-40" onClick={() => command && dispatch(command, label)}>{label}</button>)}
  </Row></Field>
}

/* ---------------- Canvas tab (no selection) ---------------- */
function CanvasTab() {
  const gridOn = useApp((s) => s.gridOn)
  const snapOn = useApp((s) => s.snapOn)
  const minimapOn = useApp((s) => s.minimapOn)
  const settings = useApp((s) => s.settings)
  const setGrid = useApp((s) => s.setGrid)
  const setSnap = useApp((s) => s.setSnap)
  const setMinimap = useApp((s) => s.setMinimap)
  const setSettings = useApp((s) => s.setSettings)
  return (
    <div>
      <Field label="Lưới">
        <Row><ToggleField value={gridOn} onChange={setGrid} /><span className="text-[11.5px] text-[var(--text2)]">Hiện lưới world-space</span></Row>
      </Field>
      <Field label="Khoảng lưới">
        <NumberInput value={settings.gridSpacing} min={8} max={200} unit="world" onCommit={(v) => v !== null && setSettings({ gridSpacing: v })} />
      </Field>
      <Field label="Snap vào lưới (Free-form)">
        <Row><ToggleField value={snapOn} onChange={setSnap} /></Row>
      </Field>
      <Field label="Mini map">
        <Row><ToggleField value={minimapOn} onChange={setMinimap} /></Row>
      </Field>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text2)]">Lưới và snap không xuất ra tệp (SRS 11.3). Zoom mặc định lưu theo session từng dự án.</p>
    </div>
  )
}

/* ---------------- Layout tab (8 cards) ---------------- */
export const LAYOUTS: { id: LayoutKind; name: string; thumb: string }[] = [
  { id: 'balanced', name: 'Balanced (cân bằng 2 bên)', thumb: 'M8 12h8m0 0c0-3 2-5 5-5m-5 5c0 3 2 5 5 5' },
  { id: 'logic', name: 'Logic (một bên)', thumb: 'M4 12h7m0 0c0-3 2-5 5-5m-5 5c0 3 2 5 5 5m2-8h.01M18 15h.01' },
  { id: 'tree', name: 'Tree (cây dọc)', thumb: 'M12 5v5m0 0h-6m6 0h6m-9 0v4m6-4v4' },
  { id: 'organization', name: 'Organization (sơ đồ tổ chức)', thumb: 'M12 4v4m-6 4h12m-9 0v4m6-4v4' },
  { id: 'radial', name: 'Radial (bánh xe)', thumb: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 12V5m0 7l6 3m-6-3l-6 3' },
  { id: 'fishbone', name: 'Fishbone (xương cá)', thumb: 'M3 12h18m-4-6l-4 6m-4-6l-2 6m10 6l-4-6' },
  { id: 'timeline', name: 'Timeline (dòng thời gian)', thumb: 'M3 12h18M6 12v-4m6 4v4m6-4v-4' },
  { id: 'freeform', name: 'Free-form (tự do)', thumb: 'M5 6h6v6H5zM13 13h6v5h-6zM8 18h.01M18 5h.01' },
]
function LayoutTab() {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const layout = doc.layout
  const setLayout = (patch: Partial<typeof layout>, label: string) => dispatch({ type: 'setLayout', before: layout, after: { ...layout, ...patch } }, label)
  const has = (k: 'direction' | 'node_gap' | 'branch_gap' | 'level_gap' | 'routing') => LAYOUT_DEFAULTS[layout.kind]?.[k] !== undefined
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        {LAYOUTS.map((l) => (
          <button key={l.id} onClick={() => useApp.getState().applyLayoutKind(l.id)}
            className={`flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-[10.5px] font-medium leading-tight transition-all ${layout.kind === l.id ? 'border-[var(--accent)] bg-[var(--accentSoft)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text2)] hover:border-[var(--accent)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`}
            title={`Chuyển sang bố cục ${l.name}`}>
            <svg width="34" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d={l.thumb} /></svg>
            {l.name.split(' (')[0]}
          </button>
        ))}
      </div>
      {has('direction') && (layout.kind === 'balanced' || layout.kind === 'logic') && (
        <Field label="Hướng">
          <Segmented value={layout.direction as string}
            options={layout.kind === 'balanced' ? [{ value: 'both', label: 'Hai bên' }, { value: 'left', label: 'Trái' }, { value: 'right', label: 'Phải' }] : [{ value: 'left', label: 'Trái' }, { value: 'right', label: 'Phải' }]}
            onChange={(v) => setLayout({ direction: v as never }, 'Hướng bố cục')} />
        </Field>
      )}
      {has('direction') && (layout.kind === 'tree' || layout.kind === 'organization') && (
        <Field label="Hướng">
          <Segmented value={layout.direction as string} options={[{ value: 'top', label: 'Xuống' }, { value: 'bottom', label: 'Lên' }]} onChange={(v) => setLayout({ direction: v as never }, 'Hướng bố cục')} />
        </Field>
      )}
      {layout.kind === 'radial' && (
        <>
          <Field label="Chiều quay">
            <Segmented value={layout.direction as string} options={[{ value: 'cw', label: 'Theo kim đồng hồ' }, { value: 'ccw', label: 'Ngược' }]} onChange={(v) => setLayout({ direction: v as never }, 'Chiều quay')} />
          </Field>
          <Field label="Góc bắt đầu">
            <NumberInput value={layout.start_angle_deg} min={-180} max={180} unit="°" onCommit={(v) => v !== null && setLayout({ start_angle_deg: v }, 'Góc bắt đầu')} />
          </Field>
        </>
      )}
      {layout.kind === 'timeline' && (
        <Field label="Sắp mốc theo">
          <Segmented value={layout.chronological ? 'date' : 'order'}
            options={[{ value: 'order', label: 'Thứ tự' }, { value: 'date', label: 'Ngày (thiếu → cuối)' }]}
            onChange={(v) => setLayout({ chronological: v === 'date', sort_policy: v === 'date' ? 'by_date' : 'user_order' }, 'Sắp mốc')} />
        </Field>
      )}
      {has('node_gap') && (
        <Field label="Khoảng node">
          <NumberInput value={layout.node_gap} min={4} max={120} onCommit={(v) => v !== null && setLayout({ node_gap: v }, 'Khoảng node')} />
        </Field>
      )}
      {has('level_gap') && (
        <Field label="Khoảng cấp">
          <NumberInput value={layout.level_gap} min={30} max={300} onCommit={(v) => v !== null && setLayout({ level_gap: v }, 'Khoảng cấp')} />
        </Field>
      )}
      {layout.kind === 'freeform' && (
        <p className="text-[11px] leading-relaxed text-[var(--text2)]">Free-form: kéo node = đổi tọa độ (không đổi cha). Kéo tay nối để chuyển cha; menu chuột phải có “Di chuyển cả nhánh”.</p>
      )}
      {has('routing') && (
        <Field label="Kiểu đường nối">
          <Segmented value={layout.routing} options={[{ value: 'curved', label: 'Cong' }, { value: 'straight', label: 'Thẳng' }, { value: 'elbow', label: 'Gãy' }]} onChange={(v) => setLayout({ routing: v }, 'Kiểu nối')} />
        </Field>
      )}
    </div>
  )
}

/* ---------------- Theme tab ---------------- */
function ThemeTab() {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {PROJECT_THEMES.map((t) => (
          <button key={t.id} onClick={() => dispatch({ type: 'setTheme', before: doc.theme_id, after: t.id }, 'Đổi chủ đề')}
            className={`rounded-xl border p-2.5 text-left text-[11.5px] transition-all ${doc.theme_id === t.id ? 'border-[var(--accent)] bg-[var(--accentSoft)] ring-2 ring-[var(--accent)]/20' : 'border-[var(--border)] hover:border-[var(--accent)] hover:bg-[var(--hover)]'}`}>
            <span className="mb-1.5 flex gap-1">
              <span className="h-5 w-5 rounded-md shadow-sm" style={{ background: t.centralFill }} />
              <span className="h-5 w-5 rounded-md border" style={{ background: t.normalFill, borderColor: t.border }} />
              <span className="h-5 w-5 rounded-md" style={{ background: t.accents[0] }} />
              <span className="h-5 w-5 rounded-md" style={{ background: t.accents[2] ?? t.edge }} />
            </span>
            <span className={`font-medium ${doc.theme_id === t.id ? 'text-[var(--accent)]' : 'text-[var(--text)]'}`}>{t.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--text3)]">Chủ đề dự án độc lập với giao diện sáng/tối của ứng dụng (LOCK-08). Override màu người dùng không đổi khi đổi theme.</p>
    </div>
  )
}

/* ---------------- Crosslink tab ---------------- */
function CrosslinkTab({ id }: { id: string }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const c = doc.crosslinks.find((x) => x.id === id)
  if (!c) return <p className="text-[12px] text-[var(--text2)]">Đường nối không còn tồn tại.</p>
  return (
    <div>
      <Field label="Nhãn">
        <TextInput value={c.label ?? ''} placeholder="Nhãn đường nối…" onChange={(e) => dispatch({ type: 'modifyCrosslink', id, before: { label: c.label ?? null }, after: { label: e.target.value || null } }, 'Nhãn nối')} />
      </Field>
      <Field label="Màu">
        <ColorField value={c.color ?? null} onCommit={(v) => dispatch({ type: 'modifyCrosslink', id, before: { color: c.color ?? null }, after: { color: v ?? undefined } }, 'Màu nối')} />
      </Field>
      <Field label="Độ dày">
        <NumberInput value={c.width_world ?? 2} min={0.5} max={12} step={0.5} onCommit={(v) => v !== null && dispatch({ type: 'modifyCrosslink', id, before: { width_world: c.width_world ?? null }, after: { width_world: v } }, 'Độ dày nối')} />
      </Field>
      <Field label="Kiểu nét">
        <Segmented value={(c.dash ?? 'dashed') as string} options={[{ value: 'solid', label: 'Liền' }, { value: 'dashed', label: 'Đứt' }, { value: 'dotted', label: 'Chấm' }]} onChange={(v) => dispatch({ type: 'modifyCrosslink', id, before: { dash: c.dash ?? null }, after: { dash: v as never } }, 'Kiểu nét')} />
      </Field>
      <Field label="Mũi tên">
        <Row>
          <label className="flex items-center gap-1 text-[11.5px]"><input type="checkbox" checked={c.arrow_start === true} onChange={(e) => dispatch({ type: 'modifyCrosslink', id, before: { arrow_start: c.arrow_start }, after: { arrow_start: e.target.checked } }, 'Mũi tên đầu')} /> Đầu nguồn</label>
          <label className="flex items-center gap-1 text-[11.5px]"><input type="checkbox" checked={c.arrow_end !== false} onChange={(e) => dispatch({ type: 'modifyCrosslink', id, before: { arrow_end: c.arrow_end }, after: { arrow_end: e.target.checked } }, 'Mũi tên đích')} /> Đích</label>
        </Row>
      </Field>
      <button onClick={() => { dispatch({ type: 'removeCrosslinks', crosslinks: [c] }, 'Xóa nối'); useApp.setState({ selection: [] }) }} className="w-full rounded-md border border-[var(--danger)] py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--hover)]">Xóa đường nối</button>
    </div>
  )
}

/* ---------------- Drawing tab ---------------- */
function DrawingTab({ id }: { id: string }) {
  const doc = useApp((s) => s.doc)!
  const dispatch = useApp((s) => s.dispatch)
  const d = doc.drawings.find((x) => x.id === id)
  if (!d) return <p className="text-[12px] text-[var(--text2)]">Nét vẽ không còn tồn tại.</p>
  return (
    <div>
      <Field label="Màu">
        <ColorField value={d.color} allowAlpha={false} onCommit={(v) => v && dispatch({ type: 'modifyDrawing', id, before: { color: d.color }, after: { color: v } }, 'Màu nét vẽ')} />
      </Field>
      <Field label="Độ dày (0.5–12)">
        <NumberInput value={d.width_world} min={0.5} max={12} step={0.5} onCommit={(v) => v !== null && dispatch({ type: 'modifyDrawing', id, before: { width_world: d.width_world }, after: { width_world: v } }, 'Độ dày nét')} />
      </Field>
      <Field label="Độ mờ">
        <SliderField value={Math.round(d.opacity * 100)} min={10} max={100} onCommit={(v) => dispatch({ type: 'modifyDrawing', id, before: { opacity: d.opacity }, after: { opacity: v / 100 } }, 'Độ mờ')} format={(v) => `${v}%`} />
      </Field>
      {(d.kind === 'rect' || d.kind === 'ellipse') && (
        <Field label="Nền hình">
          <ColorField value={d.fill ?? null} onCommit={(v) => dispatch({ type: 'modifyDrawing', id, before: { fill: d.fill ?? null }, after: { fill: v } }, 'Nền hình')} />
        </Field>
      )}
      <Field label="Lớp vẽ">
        <Row>
          <button className="rounded border border-[var(--border)] px-2 py-1 text-[11.5px]" onClick={() => dispatch({ type: 'modifyDrawing', id, before: { layer_order: d.layer_order }, after: { layer_order: (doc.drawings.reduce((a, x) => Math.max(a, x.layer_order), 0) ?? 0) + 1 } }, 'Lớp trước')}>Trước</button>
          <button className="rounded border border-[var(--border)] px-2 py-1 text-[11.5px]" onClick={() => dispatch({ type: 'modifyDrawing', id, before: { layer_order: d.layer_order }, after: { layer_order: (doc.drawings.reduce((a, x) => Math.min(a, x.layer_order), 0) ?? 0) - 1 } }, 'Lớp sau')}>Sau</button>
        </Row>
      </Field>
      <button onClick={() => { dispatch({ type: 'removeDrawings', drawings: [d] }, 'Xóa nét'); useApp.setState({ selection: [] }) }} className="w-full rounded-md border border-[var(--danger)] py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--hover)]">Xóa nét vẽ</button>
      <p className="mt-2 text-[11px] text-[var(--text2)]">Nét vẽ ở hệ tọa độ world độc lập (LOCK-07) — đổi bố cục không dịch chuyển nét vẽ.</p>
    </div>
  )
}
