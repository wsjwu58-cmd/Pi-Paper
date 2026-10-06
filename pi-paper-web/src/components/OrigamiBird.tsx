import { cn } from '@/lib/cn'

/** Origami crane mark used across empty states / agent welcome */
export function OrigamiBird({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('text-black/80', className)}
      aria-hidden
    >
      <path
        d="M58 8 L92 40 L58 28 L24 52 L40 36 L8 44 L40 28 L58 8Z"
        fill="currentColor"
        opacity="0.92"
      />
      <path
        d="M58 28 L92 40 L72 72 L58 48 L44 78 L52 48 L58 28Z"
        fill="currentColor"
        opacity="0.75"
      />
      <path
        d="M58 48 L72 72 L88 88 L64 68"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  )
}
