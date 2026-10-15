import { create } from 'zustand'
import { CheckCircle2, XCircle } from 'lucide-react'

interface ToastItem {
  id: number
  type: 'success' | 'error'
  message: string
}

export const useToast = create<{ toasts: ToastItem[]; show: (type: 'success' | 'error', message: string) => void }>(
  (set) => ({
    toasts: [],
    show(type, message) {
      const id = Date.now() + Math.random()
      set((s) => ({ toasts: [...s.toasts, { id, type, message }] }))
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500)
    },
  }),
)

export function toastSuccess(message: string) {
  useToast.getState().show('success', message)
}

export function toastError(message: string) {
  useToast.getState().show('error', message)
}

export function ToastHost() {
  const toasts = useToast((s) => s.toasts)
  return (
    <div className="fixed bottom-6 left-1/2 z-[100] flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-2 rounded-xl px-4 py-3 text-[14px] font-semibold text-white shadow-xl ${
            t.type === 'success' ? 'bg-emerald-600' : 'bg-red-600'
          }`}
        >
          {t.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          {t.message}
        </div>
      ))}
    </div>
  )
}
