import { useSyncExternalStore } from 'react'
import english from '@/locales/en.json'

export type UiLanguage = 'zh' | 'en'
export type UiLanguagePreference = UiLanguage | 'system'
const catalog: Record<string, string> = english
let language: UiLanguage = 'zh'
let preference: UiLanguagePreference = 'system'
let systemLanguage: UiLanguage = 'en'
const listeners = new Set<() => void>()

export function normalizeUiLanguage(locale: string | undefined): UiLanguage {
  return /^zh(?:[-_.@]|$)/i.test(locale?.trim() ?? '') ? 'zh' : 'en'
}

export function t(source: string, values: Record<string, unknown> = {}): string {
  const translation = catalog[source.trim()]
  const text = language === 'en' && translation
    ? (source.match(/^\s*/)?.[0] ?? '') + translation + (source.match(/\s*$/)?.[0] ?? '')
    : source
  return text.replace(/\{(\d+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key] ?? '') : match)
}

export function uiLocale(): string { return language === 'zh' ? 'zh-CN' : 'en-US' }
export function getUiLanguage() { return { language, preference, systemLanguage } }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useUiLanguage() {
  useSyncExternalStore(subscribe, () => `${language}:${preference}`, () => 'zh:system')
  return language
}

function applyLanguage(next: { language: UiLanguage; preference: UiLanguagePreference; systemLanguage: UiLanguage }) {
  language = next.language
  preference = next.preference
  systemLanguage = next.systemLanguage
  document.documentElement.lang = uiLocale()
  document.title = language === 'zh' ? 'Pi-Paper | 一张会创作的画布' : 'Pi-Paper | A canvas that creates'
  listeners.forEach((listener) => listener())
}

/** Resolve the host locale before mounting the desktop UI. Web keeps its original Chinese UI. */
export async function initializeUiLanguage() {
  if (!window.vibepaperDesktop) return
  const fallback = normalizeUiLanguage(navigator.language)
  const next = window.vibepaperDesktop.getUiLanguage
    ? await window.vibepaperDesktop.getUiLanguage()
    : { language: fallback, preference: 'system' as const, systemLanguage: fallback }
  applyLanguage(next)
}

export async function setUiLanguage(next: UiLanguagePreference) {
  if (!['system', 'zh', 'en'].includes(next)) throw new Error('Unsupported interface language')
  const bridge = window.vibepaperDesktop
  const saved = bridge?.setUiLanguage
    ? await bridge.setUiLanguage(next)
    : { language: next === 'system' ? systemLanguage : next, preference: next, systemLanguage }
  applyLanguage(saved)
}
