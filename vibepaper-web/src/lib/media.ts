import { useEffect, useState } from 'react'
import { assetUrl, getAccessToken } from './api'

const LOCAL_MEDIA_PROTOCOL = /^vibe:\/\/app\/(?:assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/output)$/iu

function resolveRendererMediaUrl(url?: string): string | undefined {
  if (!url) return undefined
  if (url.startsWith('vibe://')) return LOCAL_MEDIA_PROTOCOL.test(url) ? url : undefined
  return assetUrl(url)
}

/**
 * 解析可播放/可展示的媒体 URL。
 * 任务输出已落盘到 `/outputs/file/` 时优先走同源地址（网关已放行 GET），
 * 避免方舟等 CDN 签名链路的 CORS / 过期导致 <video> 黑屏。
 * 仅无本地缓存时再回退 remoteUrl。
 */
export function resolveMediaUrl(url?: string, meta?: Record<string, unknown> | null): string | undefined {
  const local = resolveRendererMediaUrl(url)
  if (local?.includes('/outputs/file/')) return local
  const outputType = meta?.outputType
  if (local && (outputType === 'video' || outputType === 'audio')) return local
  const remote = meta?.remoteUrl
  if (typeof remote === 'string' && remote.startsWith('http')) return remote
  return local
}

/** 需要鉴权的素材下载（存库/下载按钮）。 */
export async function fetchAuthedBlob(url?: string): Promise<Blob> {
  const full = resolveRendererMediaUrl(url)
  if (!full) throw new Error('无输出 URL')
  const headers: Record<string, string> = {}
  if (!full.startsWith('vibe://')) {
    const token = getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(full, { headers })
  if (!res.ok) throw new Error(`获取文件失败 (${res.status})`)
  return res.blob()
}

/**
 * 将可能需要鉴权的媒体 URL 转为可直接给 <img>/<video> 使用的地址。
 * 公网 http(s) 直链原样返回；同源 /api 资源用带 Token 的 blob URL。
 */
export function useAuthedMediaUrl(url?: string): string | undefined {
  const [objectUrl, setObjectUrl] = useState<string | undefined>()

  useEffect(() => {
    if (!url) {
      setObjectUrl(undefined)
      return
    }
    const resolved = resolveRendererMediaUrl(url)
    if (!resolved) {
      setObjectUrl(undefined)
      return
    }
    if (resolved.startsWith('vibe://')) {
      setObjectUrl(resolved)
      return
    }
    // 外链或已放行的任务输出可直接展示
    if (/^https?:\/\//i.test(resolved) && !resolved.includes('/api/v1/assets/file')) {
      setObjectUrl(resolved)
      return
    }
    if (resolved.includes('/tasks/') && resolved.includes('/outputs/file/')) {
      setObjectUrl(resolved)
      return
    }

    let cancelled = false
    let created: string | undefined
    void fetchAuthedBlob(resolved)
      .then((blob) => {
        if (cancelled) return
        created = URL.createObjectURL(blob)
        setObjectUrl(created)
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(resolved)
      })
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [url])

  return objectUrl
}
