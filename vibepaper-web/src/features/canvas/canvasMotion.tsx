import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactNode, RefObject } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'
import './canvas-motion.css'
import type { FlowNode } from './canvasStore'

export const CANVAS_MOTION = { enter: 280, exit: 180, viewport: 380 } as const
export const canvasMotionDuration = (duration: number) =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : duration

/** Keep closing content alive only for its visual exit, never for business work. */
export function useSoftPresence(open: boolean) {
  const [present, setPresent] = useState(open)
  const [visible, setVisible] = useState(open)
  const [settled, setSettled] = useState(open)
  useLayoutEffect(() => {
    let frame = 0
    let timer = 0
    setSettled(false)
    if (open) {
      setPresent(true)
      frame = requestAnimationFrame(() => {
        setVisible(true)
        timer = window.setTimeout(() => setSettled(true), canvasMotionDuration(CANVAS_MOTION.enter))
      })
    } else {
      setVisible(false)
      timer = window.setTimeout(() => { setPresent(false); setSettled(true) }, canvasMotionDuration(CANVAS_MOTION.exit))
    }
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [open])
  return { present, visible, settled }
}

export function useSoftValue<T>(value: T | null | undefined) {
  const presence = useSoftPresence(value != null)
  const [retained, setRetained] = useState(value)
  useLayoutEffect(() => { if (value != null) setRetained(value) }, [value])
  return { ...presence, value: presence.present || value != null ? value ?? retained : null }
}

/** Only view coordinates interpolate; persisted nodes receive their final positions immediately. */
export function useLayoutMotion(nodes: FlowNode[]) {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null)
  const frame = useRef(0)
  const cancel = () => { cancelAnimationFrame(frame.current); setPositions(null) }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const animate = (next: FlowNode[]) => {
    cancelAnimationFrame(frame.current)
    const duration = canvasMotionDuration(CANVAS_MOTION.viewport)
    if (!duration) { setPositions(null); return }
    const origins = new Map(nodes.map((node) => [node.id, positions?.get(node.id) ?? node.position]))
    const started = performance.now()
    setPositions(origins)
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      if (progress === 1) { setPositions(null); return }
      const eased = 1 - (1 - progress) ** 3
      setPositions(new Map(next.map((node) => {
        const origin = origins.get(node.id) ?? node.position
        return [node.id, { x: origin.x + (node.position.x - origin.x) * eased,
          y: origin.y + (node.position.y - origin.y) * eased }]
      })))
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }
  return { animate, cancel, nodes: positions ? nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) : nodes }
}

/** Grid reveal keeps text at natural scale and releases overflow for nested menus. */
export function SoftCollapse({ open, children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & {
  open: boolean; children: ReactNode
}) {
  const { present, visible, settled } = useSoftPresence(open)
  if (!present && !open) return null
  return (
    <div {...props} className={`vp-soft-collapse ${className}`} data-open={visible} data-settled={settled}
      aria-hidden={!open} inert={!open}>
      <div className="vp-soft-collapse-content">{children}</div>
    </div>
  )
}

/** React Flow must measure handles as the visual shell changes size. */
export function useAnimatedNodeGeometry(nodeId: string, element: RefObject<HTMLDivElement | null>) {
  const update = useUpdateNodeInternals()
  useEffect(() => {
    if (!element.current || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => update(nodeId))
    })
    observer.observe(element.current)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [element, nodeId, update])
}

const arrivals = new Map<string, number>()
export function markNodeArrival(nodeId: string) {
  const now = Date.now()
  for (const [id, time] of arrivals) if (now - time > 5000) arrivals.delete(id)
  arrivals.set(nodeId, now)
}
export function useNodeArrival(nodeId: string) {
  const [arriving] = useState(() => {
    const time = arrivals.get(nodeId)
    return time !== undefined && Date.now() - time < 5000
  })
  useEffect(() => { arrivals.delete(nodeId) }, [nodeId])
  return arriving ? 'vp-node-arrival' : ''
}

/** Animate a single explicit change, without replaying streamed text updates. */
export function useSoftChange(key: unknown, element: RefObject<HTMLElement | null>) {
  const previous = useRef(key)
  useEffect(() => {
    if (previous.current === key) return
    previous.current = key
    if (!element.current?.animate || canvasMotionDuration(CANVAS_MOTION.enter) === 0) return
    const animation = element.current.animate([{ opacity: 0.45, translate: '0 4px' }, { opacity: 1, translate: '0 0' }],
      { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)' })
    return () => animation.cancel()
  }, [element, key])
}
