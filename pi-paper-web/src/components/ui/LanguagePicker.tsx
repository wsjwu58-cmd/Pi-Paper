import { Languages } from 'lucide-react'
import { getUiLanguage, setUiLanguage, t, useUiLanguage } from '@/lib/i18n'
import type { UiLanguagePreference } from '@/lib/i18n'
import { toastError } from './Toast'

export function LanguagePicker() {
  useUiLanguage()
  return (
    <label className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-[#647086] hover:bg-black/5" title={t('界面语言')}>
      <Languages size={16} aria-hidden="true" />
      <select aria-label={t('界面语言')} value={getUiLanguage().preference}
        className="max-w-24 cursor-pointer bg-transparent text-inherit outline-none"
        onChange={(event) => { void setUiLanguage(event.target.value as UiLanguagePreference).catch((error: unknown) => toastError(error instanceof Error ? error.message : t('无法保存界面语言'))) }}>
        <option value="system">{t('跟随系统')}</option>
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
  )
}
