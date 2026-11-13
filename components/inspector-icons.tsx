'use client'
import React from 'react'

const P = (d: string) => () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)

export const CanvasIcon = P('M3 3h18v18H3z')
export const TextIcon = P('M4 7V5h16v2M12 5v14m-3 0h6')
export const SquareIcon = P('M4 4h16v16H4z')
export const GitBranchIcon = P('M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm12-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0c0 6-6 5-9 8')
export const PaperclipIcon = P('M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L16 7')
export const LayoutIcon = P('M3 3h18v6H3zM3 13h8v8H3zM13 13h8v8h-8z')
export const PaletteIcon = P('M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-2 2c0 1 .5 1.5.5 2.5S13 21 12 21zm-4.5-9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm4 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z')
export const Grid3X3 = P('M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18')
