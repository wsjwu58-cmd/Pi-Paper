import { cn } from '@/lib/cn'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'pill-dark' | 'pill-light'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

const variants: Record<Variant, string> = {
  primary:
    'h-11 rounded-[12px] bg-[#111111] px-5 text-[14px] font-bold text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)] hover:opacity-92 active:translate-y-px',
  secondary:
    'h-11 rounded-[12px] border border-[#111111] bg-transparent px-5 text-[14px] font-bold text-[#111111] hover:bg-black/[0.03]',
  ghost:
    'h-10 rounded-xl border border-black/10 bg-white px-3.5 text-[14px] font-semibold text-[#111] hover:bg-black/[0.03]',
  'pill-dark':
    'h-10 rounded-full bg-[#111111] px-5 text-[14px] font-semibold text-white',
  'pill-light':
    'h-10 rounded-full bg-white px-5 text-[14px] font-semibold text-[#111] shadow-vp-sm',
}

export function Button({
  className,
  variant = 'primary',
  leftIcon,
  rightIcon,
  children,
  ...props
}: Props) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
      {...props}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  )
}
