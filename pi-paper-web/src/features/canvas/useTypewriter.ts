import { useEffect, useRef, useState } from 'react'

/**
 * 可靠逐字：enabled 时从 0 追到 text.length；text 增长继续追；enabled 关闭后贴全文。
 */
export function useTypewriter(text: string, enabled: boolean, intervalMs = 18) {
  const [n, setN] = useState(() => (enabled ? 0 : text.length))
  const wasEnabled = useRef(enabled)

  // rising edge → 从 0 重播
  useEffect(() => {
    if (enabled && !wasEnabled.current) {
      setN(0)
    }
    if (!enabled) {
      setN(text.length)
    }
    wasEnabled.current = enabled
  }, [enabled, text.length])

  useEffect(() => {
    if (!enabled) return undefined
    if (n >= text.length) return undefined
    const id = window.setTimeout(() => {
      setN((c) => Math.min(text.length, c + (text.length - c > 80 ? 3 : 2)))
    }, intervalMs)
    return () => window.clearTimeout(id)
  }, [enabled, text, n, intervalMs])

  const shown = text.slice(0, enabled ? n : text.length)
  return {
    text: shown,
    catchingUp: enabled && n < text.length,
    done: n >= text.length && text.length > 0,
  }
}
