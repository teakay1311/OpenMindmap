/* ============================================================
 * OpenMindmap — components/ui-bits.tsx
 * Điều khiển UI chung (SRS 03.4): commit một command, Mixed "—",
 * disabled có lý do, Enter commit / Esc hoàn nguyên, liên kết a11y tự động.
 * ============================================================ */
'use client'

import React, { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeOverlay } from '../lib/scene/overlay'

const FieldContext = createContext<{ id: string; label: string } | null>(null)

export function Field({ label, children, hint, disabled }: { label: string; children: React.ReactNode; hint?: string; disabled?: boolean }) {
  const id = useId()
  return (
    <FieldContext.Provider value={{ id, label }}>
      <div className={`mb-2.5 block ${disabled ? 'opacity-50' : ''}`} title={hint}>
        <span id={id} className="mb-1.5 block text-[11px] font-medium tracking-wide text-[var(--text2)]">{label}</span>
        {children}
      </div>
    </FieldContext.Provider>
  )
}

export function Row({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex items-center gap-1.5 ${className}`}>{children}</div>
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const ctx = useContext(FieldContext)
  const labelledBy = props['aria-label'] || props['aria-labelledby'] ? props['aria-labelledby'] : ctx?.id
  return (
    <input
      {...props}
      aria-labelledby={labelledBy}
      className={`h-8 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12.5px] text-[var(--text)] transition-colors placeholder:text-[var(--text3)] focus:border-[var(--accent)] ${props.className ?? ''}`}
    />
  )
}

/** Number input: Enter/blur commit hợp lệ; invalid giữ editor; Esc phục hồi */
export function NumberInput({ value, onCommit, min, max, step = 1, unit, disabled, width = '72px', hint, 'aria-label': ariaLabel }: {
  value: number | null
  onCommit: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  disabled?: boolean
  width?: string
  hint?: string
  'aria-label'?: string
}) {
  const ctx = useContext(FieldContext)
  const [draft, setDraft] = useState<string | null>(null) // null = không đang sửa → hiển thị value
  const cancelBlur = useRef(false)
  const initial = value === null ? '—' : String(Math.round(value * 100) / 100)
  const shown = draft ?? initial
  const commit = () => {
    if (cancelBlur.current || draft === null) return
    setDraft(null)
    if (draft === initial) return
    if (draft === '—' || draft.trim() === '') { onCommit(null); return }
    let v = Number(draft.replace(',', '.'))
    if (!isFinite(v)) return
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    const shownValue = value === null ? null : Math.round(value * 100) / 100
    if (shownValue !== null && Math.abs(v - shownValue) < 1e-9) return
    onCommit(v)
  }
  return (
    <span className="inline-flex items-center" title={hint}>
      <input
        value={shown}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : ctx?.id}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { if (draft === null) setDraft(initial) }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { e.stopPropagation(); cancelBlur.current = true; setDraft(null); e.currentTarget.blur(); cancelBlur.current = false }
        }}
        style={{ width }}
        className="h-8 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12.5px] text-[var(--text)] transition-colors focus:border-[var(--accent)] disabled:opacity-50"
      />
      {unit && <span className="ml-1 text-[11px] text-[var(--text2)]">{unit}</span>}
    </span>
  )
}

/** Slider: kéo live preview (draft RAM), release = commit một lệnh */
export function SliderField({ value, min, max, step = 1, onCommit, disabled, format, 'aria-label': ariaLabel }: {
  value: number; min: number; max: number; step?: number
  onCommit: (v: number) => void
  disabled?: boolean
  format?: (v: number) => string
  'aria-label'?: string
}) {
  const ctx = useContext(FieldContext)
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? value
  return (
    <span className="inline-flex w-full items-center gap-2" title={disabled ? 'Không khả dụng trong ngữ cảnh này' : undefined}>
      <input
        type="range" min={min} max={max} step={step} value={shown} disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : ctx?.id}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag !== null && drag !== value) onCommit(drag); setDrag(null) }}
        onKeyUp={() => { if (drag !== null && drag !== value) onCommit(drag); setDrag(null) }}
        className="h-1.5 flex-1 cursor-pointer accent-[var(--accent)]"
      />
      <span className="w-12 text-right text-[11.5px] tabular-nums text-[var(--text2)]">{format ? format(shown) : shown}</span>
    </span>
  )
}

export function SelectField<T extends string>({ value, options, onChange, disabled, hint, 'aria-label': ariaLabel }: {
  value: T | '—'
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  hint?: string
  'aria-label'?: string
}) {
  const ctx = useContext(FieldContext)
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : ctx?.id}
      title={hint ?? (disabled ? 'Không khả dụng trong ngữ cảnh này' : undefined)}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-[12.5px] text-[var(--text)] transition-colors focus:border-[var(--accent)] disabled:opacity-50"
    >
      {value === '—' && <option value="—">—</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function ToggleField({ value, onChange, disabled, hint, mixed, 'aria-label': ariaLabel }: {
  value: boolean | null
  onChange: (v: boolean) => void
  disabled?: boolean
  hint?: string
  mixed?: boolean
  'aria-label'?: string
}) {
  const ctx = useContext(FieldContext)
  return (
    <button
      type="button"
      disabled={disabled}
      title={hint ?? (disabled ? 'Không khả dụng' : undefined)}
      onClick={() => onChange(!(value === true))}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${value === true ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]'} disabled:opacity-50`}
      role="switch"
      aria-checked={value === true}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : ctx?.id}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full shadow-sm transition-all ${value === true ? 'bg-[var(--onAccent)]' : 'bg-white'} ${mixed ? 'left-2.5' : value === true ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, disabled, 'aria-label': ariaLabel }: {
  value: T | '—'
  options: { value: T; label: React.ReactNode; title?: string; ariaLabel?: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  'aria-label'?: string
}) {
  const ctx = useContext(FieldContext)
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : ctx?.id}
      className={`inline-flex max-w-full shrink-0 flex-wrap rounded-md border border-[var(--border)] bg-[var(--panel-2-bg)] ${disabled ? 'opacity-50' : ''}`}
    >
      {options.map((o, i) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            title={o.title}
            aria-label={o.ariaLabel}
            aria-pressed={active}
            onClick={() => { if (!active) onChange(o.value) }}
            className={`h-7 min-w-7 shrink-0 whitespace-nowrap px-2.5 text-[11.5px] font-medium transition-colors ${i > 0 ? 'border-l border-[var(--border)]' : ''} ${active ? 'bg-[var(--accent)] text-[var(--onAccent)] shadow-sm' : 'text-[var(--text2)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}`}
          >
            {o.label}
          </button>
        )
      })}
    </span>
  )
}

/** Color picker: palette + HEX + opacity; Apply explicit (03.4) */
export function ColorField({ value, onCommit, disabled, allowAlpha = true, hint, mixed, 'aria-label': ariaLabel }: {
  value: string | null
  onCommit: (hex: string | null) => void
  disabled?: boolean
  allowAlpha?: boolean
  hint?: string
  mixed?: boolean
  'aria-label'?: string
}) {
  const ctx = useContext(FieldContext)
  const [open, setOpen] = useState(false)
  const [hex, setHex] = useState(value ?? '#17635D')
  const [alpha, setAlpha] = useState(100)
  const anchor = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLSpanElement>(null)
  const close = () => { setOpen(false); anchor.current?.focus() }
  useLayoutEffect(() => {
    if (!open || !popover.current || !anchor.current) return
    const panel = popover.current
    const position = () => {
      const a = anchor.current?.getBoundingClientRect()
      if (!a) return
      const y = a.bottom + 8 + panel.offsetHeight <= innerHeight - 8 ? a.bottom + 8 : a.top - panel.offsetHeight - 8
      const p = placeOverlay(a.left, y, panel.offsetWidth, panel.offsetHeight, innerWidth, innerHeight)
      panel.style.left = `${p.left}px`; panel.style.top = `${p.top}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(panel); observer.observe(anchor.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    panel.querySelector<HTMLElement>('button,input')?.focus()
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); anchor.current?.focus()
    }
    window.addEventListener('keydown', escape, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open])
  if (disabled && open) setOpen(false)
  const palette = ['#13201E', '#334155', '#617571', '#94A3B8', '#C63A32', '#E87930', '#D97706', '#166E4E', '#17635D', '#74D7C5', '#0EA5E9', '#2563EB', '#4F46E5', '#8B5CF6', '#EC4899', '#F4F7F6', '#FFFFFF', 'transparent']
  const apply = (h: string, a = alpha) => {
    if (h === 'transparent') { onCommit(null); close(); return }
    onCommit(allowAlpha && a < 100 ? h.slice(0, 7) + Math.round((a / 100) * 255).toString(16).padStart(2, '0') : h.slice(0, 7))
    close()
  }
  const updateHex = (v: string) => {
    setHex(v)
    if (/^#[0-9a-f]{8}$/i.test(v)) setAlpha(parseInt(v.slice(7), 16) * 100 / 255)
  }
  const validHex = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)
  const baseLabel = ariaLabel ?? ctx?.label ?? 'Màu'
  return (
    <span className="relative inline-flex" title={hint}>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        onClick={() => { if (!open) { setAlpha(100); updateHex(value ?? '#17635D') }; setOpen(!open) }}
        className="relative h-7 w-9 overflow-hidden rounded-md border border-[var(--border)] disabled:opacity-50"
        style={{ background: !mixed && value ? hexToCss(value) : 'repeating-conic-gradient(#cbd5e1 0% 25%, #fff 0% 50%) 50% / 8px 8px' }}
        aria-label={mixed ? `${baseLabel} (nhiều giá trị)` : `Chọn ${baseLabel.toLowerCase()}`}
      >
        {mixed && <span className="absolute inset-0 grid place-items-center bg-black/25 text-[11px] font-bold text-white">—</span>}
      </button>
      {open && createPortal(
        <span data-omm-control onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <span className="fixed inset-0 z-[100]" onClick={close} />
          <span ref={popover} role="dialog" aria-label={`Chọn ${baseLabel.toLowerCase()}`} className="fixed z-[101] block max-h-[calc(100dvh-16px)] w-56 max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 shadow-lg">
            <span className="grid grid-cols-9 gap-1">
              {palette.map((c) => (
                <button key={c} type="button" onClick={() => apply(c)} className="aspect-square w-full min-w-0 rounded border border-[var(--border)]" style={{ background: c === 'transparent' ? 'repeating-conic-gradient(#cbd5e1 0% 25%, #fff 0% 50%) 50% / 6px 6px' : c }} aria-label={c === 'transparent' ? 'Trong suốt' : `Màu ${c}`} />
              ))}
            </span>
            <span className="mt-2 flex items-center gap-1.5">
              <input value={hex} aria-label="Mã màu hex" onChange={(e) => updateHex(e.target.value)} className={`h-7 min-w-0 flex-1 rounded border px-1.5 text-[12px] ${validHex ? 'border-[var(--border)]' : 'border-[var(--danger)]'} bg-[var(--panel)] text-[var(--text)]`} placeholder="#RRGGBB" />
              <button type="button" onClick={() => validHex && apply(hex)} className="h-7 shrink-0 whitespace-nowrap rounded bg-[var(--accent)] px-2.5 text-[11.5px] font-medium text-[var(--onAccent)] hover:bg-[var(--accentStrong)]" disabled={!validHex}>Áp dụng</button>
            </span>
            {allowAlpha && (
              <span className="mt-2 flex items-center gap-2">
                <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--text2)]">Độ mờ</span>
                <input type="range" min={0} max={100} value={alpha} aria-label="Độ mờ màu (%)" onChange={(e) => setAlpha(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--accent)]" />
                <span className="text-[11px] tabular-nums text-[var(--text2)]">{Math.round(alpha)}%</span>
              </span>
            )}
            {value !== null && (
              <button type="button" onClick={() => { onCommit(null); close() }} className="mt-2 w-full rounded border border-[var(--border)] py-1 text-[11.5px] text-[var(--text2)] hover:bg-[var(--hover)]">Xóa override (kế thừa)</button>
            )}
          </span>
        </span>, document.body
      )}
    </span>
  )
}
export function hexToCss(hex: string): string {
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) {
    const a = parseInt(hex.slice(7), 16) / 255
    return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a.toFixed(2)})`
  }
  return hex
}

export function IconBtn({ children, onClick, title, active, disabled, danger, className = '', buttonRef, 'aria-expanded': ariaExpanded, 'aria-haspopup': ariaHaspopup, 'aria-label': ariaLabel }: {
  children: React.ReactNode
  onClick?: (e: React.MouseEvent) => void
  title?: string
  active?: boolean
  disabled?: boolean
  danger?: boolean
  className?: string
  buttonRef?: React.Ref<HTMLButtonElement>
  'aria-expanded'?: boolean
  'aria-haspopup'?: React.AriaAttributes['aria-haspopup']
  'aria-label'?: string
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Không khả dụng' : title}
      aria-label={ariaLabel ?? (typeof title === 'string' ? title.replace(/\s*\(.*\)$/, '') : undefined)}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      className={`inline-flex h-8 shrink-0 whitespace-nowrap items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors
        ${active ? 'bg-[var(--accent)] text-[var(--onAccent)] shadow-sm' : danger ? 'text-[var(--danger)] hover:bg-[var(--dangerSoft)]' : 'text-[var(--text)] hover:bg-[var(--hover)] hover:text-[var(--accent)]'}
        disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </button>
  )
}

export function Divider() {
  return <span className="mx-1 inline-block h-5 w-px bg-[var(--border)]" />
}
