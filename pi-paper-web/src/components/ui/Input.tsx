import { cn } from '@/lib/cn'
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

const base =
  'h-11 w-full rounded-xl border border-black/12 bg-white px-3.5 text-[14px] text-[#111] outline-none transition focus:border-[#111] focus:ring-2 focus:ring-black/10 disabled:opacity-50'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'h-auto min-h-24 py-3', className)} {...props} />
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(base, 'cursor-pointer', className)} {...props} />
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-[#444]">
      {label}
      {children}
    </label>
  )
}
