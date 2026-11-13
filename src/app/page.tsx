'use client'

import dynamic from 'next/dynamic'

const AppShell = dynamic(() => import('../../components/AppShell').then((m) => m.AppShell), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] text-[13px] text-[var(--text2)]">
      Đang mở OpenMindmap…
    </div>
  ),
})

export default function Page() {
  return <AppShell />
}
