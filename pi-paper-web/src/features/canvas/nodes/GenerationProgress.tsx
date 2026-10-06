import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Clapperboard, Image as ImageIcon, Type, Video } from 'lucide-react'
import type { GenerationModality, GenerationProgressInput } from './generation-progress'
import { formatElapsedSeconds, getElapsedSeconds } from './generation-progress'

const modalityMeta: Record<GenerationModality, { label: string; Icon: typeof ImageIcon }> = {
  text: { label: '文本生成', Icon: Type },
  image: { label: '图片生成', Icon: ImageIcon },
  video: { label: '视频生成', Icon: Video },
  audio: { label: '音频生成', Icon: AudioLines },
  compose: { label: '视频合成', Icon: Clapperboard },
}

export function GenerationProgress({ status, modality, startedAt, references = [] }: GenerationProgressInput) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const meta = modalityMeta[modality]
  const elapsed = useMemo(() => {
    const seconds = getElapsedSeconds(startedAt, now)
    return seconds == null ? null : formatElapsedSeconds(seconds)
  }, [now, startedAt])
  const previews = references.filter((reference) => Boolean(reference.src)).slice(0, 4)
  const stateLabel = status === 'queued'
    ? startedAt ? '排队中' : '提交中'
    : startedAt ? '生成中' : '读取任务状态'

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visible])

  return (
    <div
      ref={rootRef}
      className={`vp-generation-progress vp-generation-progress--${status} vp-generation-progress--references-${Math.min(previews.length, 4)}${visible ? ' vp-generation-progress--visible' : ''}`}
      role="status"
      aria-label={`${meta.label}，${stateLabel}${elapsed ? `，已用时 ${elapsed}` : ''}`}
      data-has-reference={previews.length > 0 ? 'true' : 'false'}
    >
      <div className="vp-generation-progress__media" aria-hidden="true">
        {previews.map((reference, index) => (
          reference.type === 'video' ? (
            <video
              key={`${reference.src}-${index}`}
              src={reference.src}
              poster={reference.poster}
              muted
              playsInline
              preload={visible ? 'metadata' : 'none'}
              className="vp-generation-progress__reference"
            />
          ) : (
            <img
              key={`${reference.src}-${index}`}
              src={reference.src}
              alt={reference.alt ?? ''}
              loading="lazy"
              className="vp-generation-progress__reference"
            />
          )
        ))}
      </div>
      <div className="vp-generation-progress__scrim" aria-hidden="true" />
      <div className="vp-generation-progress__scan" aria-hidden="true" />
      <div className="vp-generation-progress__center">
        <div className="vp-generation-progress__icon" aria-hidden="true">
          <meta.Icon size={19} strokeWidth={1.8} />
        </div>
        <span className="vp-generation-progress__modality">{meta.label}</span>
      </div>
      <span className="vp-generation-progress__state">
        {stateLabel}
      </span>
      <span className="vp-generation-progress__elapsed">
        {elapsed ? `已用时 ${elapsed}` : ''}
      </span>
    </div>
  )
}
