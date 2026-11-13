'use client'

import dynamic from 'next/dynamic'

const TransferView = dynamic(() => import('../../../components/TransferView').then((m) => m.TransferView), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] text-[13px] text-[var(--text2)]">
      Đang chuẩn bị công cụ chuyển dữ liệu…
    </div>
  ),
})

export default function TransferPage() {
  return <TransferView />
}
