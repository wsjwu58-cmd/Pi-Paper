import { t as uiText, useUiLanguage } from '@/lib/i18n'
export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  useUiLanguage()
  return (
    <div
      className={`${className} animate-spin rounded-full border-2 border-black/15 border-t-black/80`}
      role="status"
      aria-label={uiText("加载中")}
    />
  )
}
