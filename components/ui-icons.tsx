'use client'

import React from 'react'

type IconProps = { size?: number; className?: string }

function Svg({ size = 16, className = '', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** SVG nét nhánh dùng trên nút brand ở Header */
export function BrandBranchIcon({ size = 18, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`shrink-0 ${className}`} aria-hidden="true">
      <rect x="2" y="8.5" width="7" height="7" rx="2.5" fill="currentColor" />
      <path d="M9 12h4.5M13.5 12c2.2 0 2.5-6 5-6M13.5 12h5M13.5 12c2.2 0 2.5 6 5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <rect x="18" y="4" width="4" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="18" y="10" width="4" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="18" y="16" width="4" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
)
export const PanelLeftIcon = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></Svg>
)
export const FolderOpenIcon = (p: IconProps) => (
  <Svg {...p}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></Svg>
)
export const SaveIcon = (p: IconProps) => (
  <Svg {...p}><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" /></Svg>
)
export const UndoIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></Svg>
)
export const RedoIcon = (p: IconProps) => (
  <Svg {...p}><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></Svg>
)
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>
)
export const LayoutGridIcon = (p: IconProps) => (
  <Svg {...p}><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></Svg>
)
export const PaletteBrushIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="13.5" cy="6.5" r=".7" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".7" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".7" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".7" fill="currentColor" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.43-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.12a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.56C21.96 6.02 17.46 2 12 2z" /></Svg>
)
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>
)
export const PenToolIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 20h9" /><path d="M16.38 3.62a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Svg>
)
export const GridIcon = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></Svg>
)
export const UploadIcon = (p: IconProps) => (
  <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></Svg>
)
export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></Svg>
)
export const SunIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></Svg>
)
export const MoonIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Svg>
)
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>
)
export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></Svg>
)
export const AlertTriangleIcon = (p: IconProps) => (
  <Svg {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></Svg>
)
export const XCircleIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></Svg>
)
export const InfoCircleIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></Svg>
)
export const ChevronsLeftIcon = (p: IconProps) => (
  <Svg {...p}><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></Svg>
)
export const ChevronsRightIcon = (p: IconProps) => (
  <Svg {...p}><path d="m6 17 5-5-5-5" /><path d="m13 17 5-5-5-5" /></Svg>
)
