import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Props = {
  icon?: ReactNode
  title: string
  description?: string
  actions?: ReactNode
  className?: string
  search?: ReactNode
}

export function PageHeader({
  icon,
  title,
  description,
  actions,
  search,
  className,
}: Props) {
  return (
    <div
      className={cn(
        'mb-9 flex flex-wrap items-end justify-between gap-5',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {icon ? (
            <span className="inline-flex translate-y-[2px] text-[#111] [&_svg]:size-8">
              {icon}
            </span>
          ) : null}
          <h1 className="text-[30px] font-bold tracking-[-0.02em] text-[#111]">
            {title}
          </h1>
          {description ? (
            <p className="text-[15px] text-[#888]">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {search}
        {actions}
      </div>
    </div>
  )
}
