/* ============================================================
 * OpenMindmap — lib/scene/text.ts
 * TextLayoutService: đo + wrap văn bản thống nhất cho Canvas & Export
 * (V35-007: một resolver duy nhất; V35-017: 1pt = 96/72 world units)
 * ============================================================ */
import { ResolvedTextStyle } from '../core/style'

export const PT_TO_WORLD = 96 / 72 // 1.333333

let ctx: CanvasRenderingContext2D | null = null
function measureCtx(): CanvasRenderingContext2D {
  if (!ctx) {
    const c = document.createElement('canvas')
    c.width = 8; c.height = 8
    ctx = c.getContext('2d')!
  }
  return ctx
}

export function fontString(s: Pick<ResolvedTextStyle, 'fontFamily' | 'fontSizePt' | 'fontWeight' | 'italic'>): string {
  const px = s.fontSizePt * PT_TO_WORLD
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${px}px ${s.fontFamily}`
}

let lastFont = ''

interface TextMeasurementSessionCache {
  width: Map<string, number>
  centered: Map<string, TextMetrics>
}
let currentSessionCache: TextMeasurementSessionCache | null = null
const SESSION_CACHE_MAX_ENTRIES = 2048

export function beginTextMeasurementSession(): void {
  currentSessionCache = {
    width: new Map(),
    centered: new Map(),
  }
}

export function endTextMeasurementSession(): void {
  currentSessionCache = null
}

export function measureTextWidth(text: string, font: string): number {
  if (!text) return 0
  if (currentSessionCache) {
    const key = `${font}\0${text}`
    const cached = currentSessionCache.width.get(key)
    if (cached !== undefined) return cached
    const c = measureCtx()
    if (c.font !== font) {
      c.font = font
      lastFont = font
    }
    const w = c.measureText(text).width
    if (currentSessionCache.width.size + currentSessionCache.centered.size < SESSION_CACHE_MAX_ENTRIES) {
      currentSessionCache.width.set(key, w)
    }
    return w
  }
  const c = measureCtx()
  if (c.font !== font) {
    c.font = font
    lastFont = font
  }
  return c.measureText(text).width
}

export function measureCenteredText(text: string, font: string): TextMetrics {
  if (currentSessionCache) {
    const key = `${font}\0${text}`
    const cached = currentSessionCache.centered.get(key)
    if (cached !== undefined) return cached
    const c = measureCtx()
    c.save()
    c.font = font
    c.textAlign = 'center'
    c.textBaseline = 'alphabetic'
    const metrics = c.measureText(text)
    c.restore()
    if (currentSessionCache.width.size + currentSessionCache.centered.size < SESSION_CACHE_MAX_ENTRIES) {
      currentSessionCache.centered.set(key, metrics)
    }
    return metrics
  }
  const c = measureCtx()
  c.save()
  c.font = font
  c.textAlign = 'center'
  c.textBaseline = 'alphabetic'
  const metrics = c.measureText(text)
  c.restore()
  return metrics
}

/* ---------- Wrap: tôn trọng manual newline, không cắt grapheme ---------- */
interface CachedLines { texts: string[]; lineParas: number[] }
const wrapCache = new Map<string, CachedLines>()
function cacheGet(key: string): CachedLines | undefined { return wrapCache.get(key) }
function cacheSet(key: string, val: CachedLines) {
  if (wrapCache.size > 4000) wrapCache.clear()
  wrapCache.set(key, val)
}

/** Chia 1 đoạn thành các dòng theo maxWidth (word-boundary trước, grapheme sau) */
function wrapParagraph(par: string, font: string, maxWidth: number): string[] {
  if (!par) return ['']
  const words = par.split(/(?<=\s)/) // giữ khoảng trắng theo từ
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (measureTextWidth((cur + w).trimEnd(), font) <= maxWidth) { cur += w; continue }
    if (cur.trim()) lines.push(cur.trimEnd())
    cur = ''
    if (measureTextWidth(w.trimEnd(), font) <= maxWidth) { cur = w; continue }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(w)) {
      if (cur && measureTextWidth(cur + segment, font) > maxWidth) {
        if (cur.trim()) lines.push(cur.trimEnd())
        cur = ''
      }
      if (!cur && /^\s+$/.test(segment)) continue
      cur += segment
    }
  }
  if (cur || !lines.length) lines.push(cur.trimEnd())
  return lines
}

export interface TextBlock {
  lines: { text: string; width: number }[]
  lineY: number[] // baseline offsets from the text block top
  lineH: number
  width: number
  height: number
  paraCount: number
}

/** Đo & wrap toàn bộ title. maxWidth = null → không wrap (1 dòng/đoạn) */
export function layoutTextBlock(text: string, s: ResolvedTextStyle, maxWidth: number | null): TextBlock {
  const font = fontString(s)
  const key = `${font}|${maxWidth ?? 0}|${text.length}|${text}`
  const hit = cacheGet(key)
  const paras = text.split('\n')
  const lineH = s.fontSizePt * PT_TO_WORLD * s.lineHeight
  let raw: string[]
  let lineParas: number[]
  if (hit) {
    raw = hit.texts
    lineParas = hit.lineParas
  } else {
    raw = []
    lineParas = []
    for (let pi = 0; pi < paras.length; pi++) {
      const par = paras[pi]
      const plines = maxWidth && maxWidth > 0 && s.wrap ? wrapParagraph(par, font, maxWidth) : [par]
      for (const pl of plines) { raw.push(pl); lineParas.push(pi) }
    }
    cacheSet(key, { texts: raw, lineParas })
  }
  const lines = raw.map((t) => ({ text: t, width: measureTextWidth(t, font) }))
  const width = Math.max(1, ...lines.map((l) => l.width))
  const paraCount = paras.filter((p) => p.trim() !== '').length
  // Baseline positions preserve manual paragraph boundaries. paragraphGap is only
  // inserted when crossing from one newline-separated paragraph to the next; wrapped
  // lines inside one paragraph stay at lineH.
  const lineY: number[] = []
  let top = 0
  for (let i = 0; i < lines.length; i++) {
    lineY.push(top + lineH * 0.72)
    top += lineH
    if (i + 1 < lines.length && lineParas[i + 1] !== lineParas[i]) top += s.paragraphGap
  }
  const height = top
  return { lines, lineY, lineH, width, height, paraCount }
}

export function clearTextCache() { wrapCache.clear() }
