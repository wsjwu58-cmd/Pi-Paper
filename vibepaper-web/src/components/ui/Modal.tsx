import { X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  size = 'md',
  hideHeader,
  className,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  wide?: boolean
  size?: 'md' | 'lg' | 'xl' | 'publication'
  hideHeader?: boolean
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null
  const maxW = wide || size === 'lg'
    ? 'max-w-3xl'
    : size === 'xl'
      ? 'max-w-5xl'
      : size === 'publication'
        ? 'max-w-[1380px]'
        : 'max-w-md'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#8a8c91]/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className={cn(
          'relative max-h-[90vh] w-full overflow-auto rounded-[32px] bg-white p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)] sm:p-8',
          maxW,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {!hideHeader ? (
          <div className="mb-5 flex items-center justify-between">
            {title ? <h2 className="text-[20px] font-bold text-[#111]">{title}</h2> : <span />}
            <button onClick={onClose} className="rounded-full p-2 text-[#666] hover:bg-black/5" aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        ) : (
          <button
            onClick={onClose}
            className="absolute right-5 top-5 z-10 rounded-full p-2 text-[#666] hover:bg-black/5"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  danger,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  danger?: boolean
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="mb-5 whitespace-pre-line text-[14px] text-[#555]">{message}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="h-10 rounded-[16px] border border-black/10 px-4 text-[14px] font-semibold hover:bg-black/[0.03]"
        >
          取消
        </button>
        <button
          onClick={() => {
            onConfirm()
            onClose()
          }}
          className={`h-10 rounded-[16px] px-4 text-[14px] font-semibold text-white ${
            danger ? 'bg-red-600 hover:bg-red-700' : 'bg-[#111]'
          }`}
        >
          确认
        </button>
      </div>
    </Modal>
  )
}
