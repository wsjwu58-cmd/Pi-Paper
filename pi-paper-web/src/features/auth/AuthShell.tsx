import type { ReactNode } from 'react'

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50/60 p-4">
      <div className="w-full max-w-md rounded-3xl border border-black/5 bg-white p-8 shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#111] text-[22px] font-black text-white">
            V
          </div>
          <h1 className="text-[22px] font-black text-[#111]">{title}</h1>
          <p className="mt-1 text-[13px] text-[#666]">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}
