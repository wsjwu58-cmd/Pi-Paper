import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Armchair,
  Box,
  Camera,
  Circle,
  Cone,
  Cylinder,
  DoorOpen,
  Fence,
  Lamp,
  Layers3,
  PersonStanding,
  Pyramid,
  Table,
  TreePine,
  X,
} from 'lucide-react'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { useAuthedMediaUrl } from '@/lib/media'
import { isDesktopRuntime, saveDirectorCapturePort } from '../canvasPort'
import { cameraAt, readCreativeCamera, readCreativeMotion, readCreativeScene } from '../creativePluginRuntime'
import type { CreativeMotion } from '../creativePluginTypes'
import type { MarketplaceComponent } from '@/desktop/desktop-bridge'
import {
  CHARACTER_CATALOG,
  CHARACTER_ENTRY,
  CHARACTER_POSES,
  nextObjectName,
  PRIMITIVE_CATALOG,
  PROP_CATALOG,
  type CatalogItem,
} from './catalog'
import { DirectorViewport, type DirectorCaptureApi } from './DirectorViewport'
import {
  createObjectId,
  DEFAULT_CAMERA,
  type CharacterPose,
  type DirectorCamera,
  type DirectorObject,
  type DirectorSceneState,
} from './types'

function CatalogIcon({ name, size = 18 }: { name: string; size?: number }) {
  useUiLanguage()
  const props = { size, strokeWidth: 1.6 as const }
  switch (name) {
    case 'person':
      return <PersonStanding {...props} />
    case 'steps':
      return <Layers3 {...props} />
    case 'wall':
      return <Box {...props} />
    case 'arch':
      return <DoorOpen {...props} />
    case 'table':
      return <Table {...props} />
    case 'chair':
      return <Armchair {...props} />
    case 'lamp':
      return <Lamp {...props} />
    case 'tree':
      return <TreePine {...props} />
    case 'fence':
      return <Fence {...props} />
    case 'cube':
      return <Box {...props} />
    case 'sphere':
      return <Circle {...props} />
    case 'cylinder':
      return <Cylinder {...props} />
    case 'cone':
      return <Cone {...props} />
    case 'torus':
      return <Circle {...props} />
    case 'capsule':
      return <Cylinder {...props} />
    case 'pyramid':
      return <Pyramid {...props} />
    default:
      return <Box {...props} />
  }
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: string
  onChange: (v: number) => void
}) {
  useUiLanguage()
  return (
    <label className="flex items-center gap-2.5 text-[12px] text-[#555]">
      <span className="w-8 shrink-0 font-semibold text-[#333]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer accent-[#111]"
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-[#888]">{display ?? value}</span>
    </label>
  )
}

function CatalogButton({
  item,
  onAdd,
  active,
}: {
  item: CatalogItem
  onAdd: (item: CatalogItem) => void
  active?: boolean
}) {
  useUiLanguage()
  return (
    <button
      type="button"
      title={uiText(item.label)}
      onClick={() => onAdd(item)}
      className={`flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-xl text-[#444] transition hover:bg-black/[0.05] ${
        active ? 'bg-black/[0.06] ring-1 ring-black/10' : 'bg-[#f6f6f8]'
      }`}
    >
      <CatalogIcon name={item.icon} size={18} />
      <span className="text-[10px] font-semibold leading-none">{uiText(item.label)}</span>
    </button>
  )
}

export function DirectorStageEditor({
  open,
  initial,
  canvasId,
  nodeId,
  onClose,
  onSave,
}: {
  open: boolean
  initial: DirectorSceneState
  canvasId?: string | number
  nodeId: string | number
  onClose: () => void
  onSave: (state: DirectorSceneState, latestUrl: string | null) => void
}) {
  useUiLanguage()
  const desktopMode = isDesktopRuntime()
  const [objects, setObjects] = useState<DirectorObject[]>(initial.objects)
  const [camera, setCamera] = useState<DirectorCamera>(initial.camera ?? DEFAULT_CAMERA)
  const [captures, setCaptures] = useState<string[]>(initial.captures ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [posePicker, setPosePicker] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [motion, setMotion] = useState<CreativeMotion | undefined>(initial.motion)
  const [playing, setPlaying] = useState(false)
  const [creativeItems, setCreativeItems] = useState<Array<{ packageId: string; component: MarketplaceComponent }>>([])
  const [creativeBusy, setCreativeBusy] = useState(false)
  const [undoCreative, setUndoCreative] = useState<{ objects: DirectorObject[]; camera: DirectorCamera; motion?: CreativeMotion } | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const draftRef = useRef({ objects, camera, motion })
  draftRef.current = { objects, camera, motion }
  const [dirty, setDirty] = useState(false)
  const viewportRef = useRef<DirectorCaptureApi>(null)

  useEffect(() => {
    if (!open) return
    setObjects(initial.objects)
    setCamera(initial.camera ?? DEFAULT_CAMERA)
    setCaptures(initial.captures ?? [])
    setMotion(initial.motion)
    setPlaying(false)
    setUndoCreative(null)
    setSelectedId(null)
    setPosePicker(false)
    setDirty(false)
  }, [open, initial])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        removeSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedId, objects, camera, captures, dirty])

  useEffect(() => {
    if (!open || !window.vibepaperDesktop?.marketplace) { setCreativeItems([]); return }
    let cancelled = false
    const bridge = window.vibepaperDesktop
    void bridge.getActiveProject().then(async (project) => {
      if (!project || String(project.canvasId) !== String(canvasId)) return []
      const packages = await bridge.marketplace.list(project.projectId)
      return packages.flatMap((pkg) => pkg.components
        .filter((component) => component.installed && component.enabled && ['director_scene', 'director_camera', 'director_motion'].includes(component.type))
        .map((component) => ({ packageId: pkg.id, component })))
    }).then((items) => { if (!cancelled) setCreativeItems(items) }).catch(() => { if (!cancelled) setCreativeItems([]) })
    return () => { cancelled = true }
  }, [open, canvasId])

  useEffect(() => {
    if (!open || !playing || !motion) return
    let frame = 0
    let started: number | undefined
    const tick = (now: number) => {
      started ??= now
      const progress = Math.min(1, (now - started) / (motion.duration * 1000))
      setCamera(cameraAt(motion, progress))
      if (progress < 1) frame = window.requestAnimationFrame(tick)
      else setPlaying(false)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [open, playing, motion])

  const selected = useMemo(() => objects.find((o) => o.id === selectedId) ?? null, [objects, selectedId])

  const markDirty = () => { setDirty(true); setUndoCreative(null) }

  const applyCreativeItem = async (packageId: string, componentId: string) => {
    if (creativeBusy) return
    setCreativeBusy(true)
    try {
      const bridge = window.vibepaperDesktop
      const project = await bridge?.getActiveProject()
      if (!bridge || !project || String(project.canvasId) !== String(canvasId)) throw new Error(uiText('当前项目或画布已更改。'))
      const packages = await bridge.marketplace.list(project.projectId)
      const component = packages.find((pkg) => pkg.id === packageId)?.components.find((item) => item.id === componentId)
      const current = await bridge.getActiveProject()
      if (!openRef.current || !current || current.projectId !== project.projectId || current.canvasId !== project.canvasId) throw new Error(uiText('当前项目或画布已更改。'))
      if (!component?.installed || !component.enabled) throw new Error(uiText('组件已停用或卸载。'))
      const draft = draftRef.current
      const previous = { objects: draft.objects, camera: draft.camera, motion: draft.motion }
      if (component.type === 'director_scene') {
        const scene = readCreativeScene(component.data)
        if (draft.objects.length + scene.objects.length > 200) throw new Error(uiText('导演场景对象过多。'))
        setObjects([...draft.objects, ...scene.objects.map((object) => ({ ...object, id: createObjectId() }))])
        setCamera(scene.camera)
        setSelectedId(null)
      } else if (component.type === 'director_camera') {
        setCamera(readCreativeCamera(component.data))
      } else if (component.type === 'director_motion') {
        setMotion(readCreativeMotion(component.data))
      } else throw new Error(uiText('该组件不能用于导演台。'))
      setPlaying(false)
      setDirty(true)
      setUndoCreative(previous)
    } catch (error) {
      toastError(error instanceof Error ? error.message : uiText('应用导演组件失败。'))
    } finally { setCreativeBusy(false) }
  }

  const addFromCatalog = (item: CatalogItem) => {
    if (item.category === 'character' && item.label === '人物' && !posePicker) {
      setPosePicker(true)
      return
    }
    const name = nextObjectName(item.kind, objects.map((o) => o.name))
    const offset = objects.length * 0.55
    const obj: DirectorObject = {
      id: createObjectId(),
      category: item.category,
      kind: item.kind,
      name,
      position: [(offset % 3) - 1, 0, Math.floor(offset / 3) * 0.7 - 0.5],
      rotation: 0,
      scale: item.defaultScale,
      color: item.defaultColor,
    }
    setObjects((prev) => [...prev, obj])
    setSelectedId(obj.id)
    setPosePicker(false)
    markDirty()
  }

  const addCharacterPose = (pose: CharacterPose) => {
    const item = CHARACTER_CATALOG.find((c) => c.kind === pose) ?? CHARACTER_CATALOG[0]
    addFromCatalog({ ...item, kind: pose, label: pose })
  }

  const patchSelected = (patch: Partial<DirectorObject>) => {
    if (!selectedId) return
    setObjects((prev) => prev.map((o) => (o.id === selectedId ? { ...o, ...patch } : o)))
    markDirty()
  }

  const removeSelected = () => {
    if (!selectedId) return
    setObjects((prev) => prev.filter((o) => o.id !== selectedId))
    setSelectedId(null)
    markDirty()
  }

  const doCapture = useCallback(async (): Promise<string | null> => {
    setCapturing(true)
    try {
      const blob = await viewportRef.current?.capturePng()
      if (!blob) throw new Error(uiText("截图失败"))
      const asset = await saveDirectorCapturePort(blob, canvasId, nodeId)
      setCaptures((prev) => [...prev, asset.url].slice(-12))
      setDirty(false)
      toastSuccess(uiText("拍照完成"))
      return asset.url
    } catch (e) {
      toastError((e as Error).message || uiText("拍照失败"))
      return null
    } finally {
      setCapturing(false)
    }
  }, [canvasId, nodeId])

  const handleClose = async () => {
    let nextCaptures = [...captures]
    let url = nextCaptures[nextCaptures.length - 1] ?? null
    if (dirty) {
      const captured = await doCapture()
      if (captured) {
        url = captured
        if (!nextCaptures.includes(captured)) nextCaptures = [...nextCaptures, captured].slice(-12)
      }
    }
    setPlaying(false)
    onSave({ objects, camera, captures: nextCaptures, ...(desktopMode && motion ? { motion } : {}) }, url)
    onClose()
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#f3f3f6]/92 backdrop-blur-[2px]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-black/6 bg-white/90 px-4">
        <div className="text-[14px] font-bold text-[#222]">{uiText("导演台")}</div>
        <button
          type="button"
          onClick={() => void handleClose()}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[#555] hover:bg-black/10"
          title={uiText("关闭")}
        >
          <X size={16} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <DirectorViewport
          ref={viewportRef}
          className="absolute inset-0"
          objects={objects}
          camera={camera}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {/* 左侧：添加模型 */}
        <aside className="absolute left-4 top-4 z-10 max-h-[calc(100vh-6rem)] w-[200px] overflow-y-auto rounded-2xl bg-white/95 p-3 shadow-[0_12px_40px_rgba(15,23,42,0.12)] ring-1 ring-black/6 backdrop-blur">
          <p className="mb-2 text-[12px] font-bold text-[#333]">{uiText("点击添加模型")}</p>

          <p className="mb-1.5 text-[11px] font-semibold text-[#888]">{uiText("人物模型")}</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <CatalogButton item={CHARACTER_ENTRY} onAdd={addFromCatalog} active={posePicker} />
          </div>
          {posePicker && (
            <div className="mb-3 max-h-40 space-y-1 overflow-y-auto rounded-xl bg-[#f6f6f8] p-2">
              {CHARACTER_POSES.map((pose) => (
                <button
                  key={pose}
                  type="button"
                  onClick={() => addCharacterPose(pose)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-[#444] hover:bg-white"
                >
                  <PersonStanding size={14} />
                  {pose}
                </button>
              ))}
            </div>
          )}

          <p className="mb-1.5 text-[11px] font-semibold text-[#888]">{uiText("场景模型")}</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PROP_CATALOG.map((item) => (
              <CatalogButton key={item.kind} item={item} onAdd={addFromCatalog} />
            ))}
          </div>

          <p className="mb-1.5 text-[11px] font-semibold text-[#888]">{uiText("基础模型")}</p>
          <div className="flex flex-wrap gap-1.5">
            {PRIMITIVE_CATALOG.map((item) => (
              <CatalogButton key={item.kind} item={item} onAdd={addFromCatalog} />
            ))}
          </div>
          {creativeItems.length > 0 && <div className="mt-4 border-t border-black/10 pt-3">
            <p className="mb-1 text-[11px] font-bold text-[#555]">{uiText('已启用导演组件')}</p>
            <p className="mb-2 text-[10px] leading-4 text-[#888]">{uiText('场景追加对象并设置机位；机位和运镜可继续调整。')}</p>
            {creativeItems.map(({ packageId, component }) => <button key={packageId + ':' + component.id} type="button" disabled={creativeBusy}
              onClick={() => void applyCreativeItem(packageId, component.id)} className="mb-1 block w-full rounded-lg bg-[#f6f6f8] px-2 py-1.5 text-left text-[11px] font-semibold text-[#444] hover:bg-black/10 disabled:opacity-50">{uiText(component.name)}</button>)}
            {undoCreative && <button type="button" onClick={() => { setObjects(undoCreative.objects); setCamera(undoCreative.camera); setMotion(undoCreative.motion); setPlaying(false); setUndoCreative(null); setDirty(true) }} className="mt-1 text-[11px] font-semibold text-[#315a96]">{uiText('撤销插件应用')}</button>}
          </div>}
        </aside>

        {/* 右侧：已选中 */}
        {selected && (
          <aside className="absolute right-4 top-4 z-10 w-[220px] rounded-2xl bg-white/95 p-3.5 shadow-[0_12px_40px_rgba(15,23,42,0.12)] ring-1 ring-black/6 backdrop-blur">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <p className="text-[13px] font-bold text-[#222]">{selected.name}</p>
                <p className="text-[11px] text-[#888]">{selected.kind}</p>
              </div>
              {selected.category === 'character' && (
                <input
                  type="color"
                  value={selected.color}
                  onChange={(e) => patchSelected({ color: e.target.value })}
                  className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent"
                  title={uiText("颜色")}
                />
              )}
            </div>
            <div className="space-y-2.5">
              <SliderRow
                label="X"
                value={selected.position[0]}
                min={-6}
                max={6}
                step={0.05}
                display={selected.position[0].toFixed(2)}
                onChange={(v) =>
                  patchSelected({ position: [v, selected.position[1], selected.position[2]] })
                }
              />
              <SliderRow
                label="Z"
                value={selected.position[2]}
                min={-6}
                max={6}
                step={0.05}
                display={selected.position[2].toFixed(2)}
                onChange={(v) =>
                  patchSelected({ position: [selected.position[0], selected.position[1], v] })
                }
              />
              <SliderRow
                label="Y"
                value={selected.position[1]}
                min={-1}
                max={4}
                step={0.05}
                display={selected.position[1].toFixed(2)}
                onChange={(v) =>
                  patchSelected({ position: [selected.position[0], v, selected.position[2]] })
                }
              />
              <SliderRow
                label={uiText("旋转")}
                value={selected.rotation}
                min={-180}
                max={180}
                step={1}
                display={`${Math.round(selected.rotation)}°`}
                onChange={(v) => patchSelected({ rotation: v })}
              />
              <SliderRow
                label={uiText("缩放")}
                value={selected.scale}
                min={0.3}
                max={3}
                step={0.01}
                display={selected.scale.toFixed(2)}
                onChange={(v) => patchSelected({ scale: v })}
              />
              {selected.category === 'character' && (
                <label className="flex items-center gap-2 text-[12px] text-[#555]">
                  <span className="w-8 shrink-0 font-semibold text-[#333]">{uiText("姿势")}</span>
                  <select
                    className="h-8 flex-1 rounded-lg border border-black/8 bg-[#f6f6f8] px-2 text-[11px] font-semibold"
                    value={selected.kind}
                    onChange={(e) =>
                      patchSelected({
                        kind: e.target.value as CharacterPose,
                        name: selected.name.replace(/^.+?(?=\s\d|$)/, e.target.value),
                      })
                    }
                  >
                    {CHARACTER_POSES.map((p) => (
                      <option key={p} value={p}>
                        {uiText(p)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button
              type="button"
              onClick={removeSelected}
              className="mt-4 w-full rounded-xl bg-[#111] py-2.5 text-[13px] font-bold text-white hover:bg-black"
            >
              {uiText("删除模型")}</button>
          </aside>
        )}

        {/* 底部：朝向预览 + 拍照 + 机位 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-4 p-4">
          <div className="pointer-events-auto flex items-end gap-3">
            {selected?.category === 'character' && (
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/95 shadow ring-1 ring-black/6">
                <div
                  className="h-8 w-5 rounded-sm bg-[#e85d6c]"
                  style={{ transform: `rotate(${selected.rotation}deg)` }}
                  title={uiText("角色朝向")}
                />
              </div>
            )}
            {captures.length > 0 && (
              <div className="flex max-w-[420px] gap-2 overflow-x-auto rounded-2xl bg-white/95 p-2 shadow ring-1 ring-black/6">
                {captures.map((url, i) => (
                  <CaptureThumb key={`${url}-${i}`} url={url} active={i === captures.length - 1} />
                ))}
              </div>
            )}
          </div>

          <div className="pointer-events-auto flex items-end gap-3">
            <div className="w-[200px] rounded-2xl bg-white/95 p-3 shadow ring-1 ring-black/6">
              <p className="mb-2 text-[11px] font-bold text-[#555]">{uiText("机位")}</p>
              <div className="space-y-2">
                <SliderRow
                  label="Yaw"
                  value={camera.yaw}
                  min={-180}
                  max={180}
                  display={`${Math.round(camera.yaw)}°`}
                  onChange={(v) => {
                    setCamera((c) => ({ ...c, yaw: v }))
                    markDirty()
                  }}
                />
                <SliderRow
                  label="Pitch"
                  value={camera.pitch}
                  min={5}
                  max={80}
                  display={`${Math.round(camera.pitch)}°`}
                  onChange={(v) => {
                    setCamera((c) => ({ ...c, pitch: v }))
                    markDirty()
                  }}
                />
                <SliderRow
                  label={uiText("距")}
                  value={camera.distance}
                  min={3}
                  max={20}
                  step={0.1}
                  display={camera.distance.toFixed(1)}
                  onChange={(v) => {
                    setCamera((c) => ({ ...c, distance: v }))
                    markDirty()
                  }}
                />
              </div>
            </div>
            {desktopMode && <div className="w-[210px] rounded-2xl bg-white/95 p-3 shadow ring-1 ring-black/6">
              <p className="mb-2 text-[11px] font-bold text-[#555]">{uiText('机位过渡')}</p>
              <div className="flex gap-1">
                <button type="button" onClick={() => { setMotion((current) => ({ from: { ...camera }, to: current?.to ?? { ...camera }, duration: current?.duration ?? 4 })); markDirty() }} className="rounded-lg bg-[#f3f3f6] px-2 py-1 text-[10px]">{uiText('起点设为当前')}</button>
                <button type="button" onClick={() => { setMotion((current) => ({ from: current?.from ?? { ...camera }, to: { ...camera }, duration: current?.duration ?? 4 })); markDirty() }} className="rounded-lg bg-[#f3f3f6] px-2 py-1 text-[10px]">{uiText('终点设为当前')}</button>
              </div>
              {motion && <div className="mt-2 flex items-center gap-2 text-[10px] text-[#555]">
                <label>{uiText('时长（秒）')} <input aria-label={uiText('过渡时长')} type="number" min="0.5" max="30" step="0.5" value={motion.duration} onChange={(e) => { const duration = Number(e.target.value); if (duration >= 0.5 && duration <= 30) { setMotion({ ...motion, duration }); markDirty() } }} className="w-12 rounded border border-black/10 px-1" /></label>
                <button type="button" onClick={() => { if (playing) setPlaying(false); else { markDirty(); setPlaying(true) } }} className="rounded bg-[#222] px-2 py-1 text-white">{playing ? uiText('停止') : uiText('播放')}</button>
              </div>}
            </div>}
            <button
              type="button"
              disabled={capturing}
              onClick={() => void doCapture()}
              className="flex h-12 items-center gap-2 rounded-2xl bg-[#111] px-5 text-[14px] font-bold text-white shadow-lg hover:bg-black disabled:opacity-60"
            >
              <Camera size={18} />
              {capturing ? uiText("拍照中…") : uiText("拍照")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function CaptureThumb({ url, active }: { url: string; active?: boolean }) {
  useUiLanguage()
  const src = useAuthedMediaUrl(url)
  return (
    <div
      className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-[#f0f0f2] ${
        active ? 'ring-2 ring-[#111]' : 'ring-1 ring-black/8'
      }`}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}
    </div>
  )
}
