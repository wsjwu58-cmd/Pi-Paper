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
import { saveDirectorCapturePort } from '../canvasPort'
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
  return (
    <button
      type="button"
      title={item.label}
      onClick={() => onAdd(item)}
      className={`flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-xl text-[#444] transition hover:bg-black/[0.05] ${
        active ? 'bg-black/[0.06] ring-1 ring-black/10' : 'bg-[#f6f6f8]'
      }`}
    >
      <CatalogIcon name={item.icon} size={18} />
      <span className="text-[10px] font-semibold leading-none">{item.label}</span>
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
  const [objects, setObjects] = useState<DirectorObject[]>(initial.objects)
  const [camera, setCamera] = useState<DirectorCamera>(initial.camera ?? DEFAULT_CAMERA)
  const [captures, setCaptures] = useState<string[]>(initial.captures ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [posePicker, setPosePicker] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const viewportRef = useRef<DirectorCaptureApi>(null)

  useEffect(() => {
    if (!open) return
    setObjects(initial.objects)
    setCamera(initial.camera ?? DEFAULT_CAMERA)
    setCaptures(initial.captures ?? [])
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

  const selected = useMemo(() => objects.find((o) => o.id === selectedId) ?? null, [objects, selectedId])

  const markDirty = () => setDirty(true)

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
      if (!blob) throw new Error('截图失败')
      const asset = await saveDirectorCapturePort(blob, canvasId, nodeId)
      setCaptures((prev) => [...prev, asset.url].slice(-12))
      setDirty(false)
      toastSuccess('拍照完成')
      return asset.url
    } catch (e) {
      toastError((e as Error).message || '拍照失败')
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
    onSave({ objects, camera, captures: nextCaptures }, url)
    onClose()
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#f3f3f6]/92 backdrop-blur-[2px]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-black/6 bg-white/90 px-4">
        <div className="text-[14px] font-bold text-[#222]">导演台</div>
        <button
          type="button"
          onClick={() => void handleClose()}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[#555] hover:bg-black/10"
          title="关闭"
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
        <aside className="absolute left-4 top-4 z-10 w-[200px] rounded-2xl bg-white/95 p-3 shadow-[0_12px_40px_rgba(15,23,42,0.12)] ring-1 ring-black/6 backdrop-blur">
          <p className="mb-2 text-[12px] font-bold text-[#333]">点击添加模型</p>

          <p className="mb-1.5 text-[11px] font-semibold text-[#888]">人物模型</p>
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

          <p className="mb-1.5 text-[11px] font-semibold text-[#888]">场景模型</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PROP_CATALOG.map((item) => (
              <CatalogButton key={item.kind} item={item} onAdd={addFromCatalog} />
            ))}
          </div>

          <p className="mb-1.5 text-[11px] font-semibold text-[#888]">基础模型</p>
          <div className="flex flex-wrap gap-1.5">
            {PRIMITIVE_CATALOG.map((item) => (
              <CatalogButton key={item.kind} item={item} onAdd={addFromCatalog} />
            ))}
          </div>
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
                  title="颜色"
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
                label="旋转"
                value={selected.rotation}
                min={-180}
                max={180}
                step={1}
                display={`${Math.round(selected.rotation)}°`}
                onChange={(v) => patchSelected({ rotation: v })}
              />
              <SliderRow
                label="缩放"
                value={selected.scale}
                min={0.3}
                max={3}
                step={0.01}
                display={selected.scale.toFixed(2)}
                onChange={(v) => patchSelected({ scale: v })}
              />
              {selected.category === 'character' && (
                <label className="flex items-center gap-2 text-[12px] text-[#555]">
                  <span className="w-8 shrink-0 font-semibold text-[#333]">姿势</span>
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
                        {p}
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
              删除模型
            </button>
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
                  title="角色朝向"
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
              <p className="mb-2 text-[11px] font-bold text-[#555]">机位</p>
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
                  label="距"
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
            <button
              type="button"
              disabled={capturing}
              onClick={() => void doCapture()}
              className="flex h-12 items-center gap-2 rounded-2xl bg-[#111] px-5 text-[14px] font-bold text-white shadow-lg hover:bg-black disabled:opacity-60"
            >
              <Camera size={18} />
              {capturing ? '拍照中…' : '拍照'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function CaptureThumb({ url, active }: { url: string; active?: boolean }) {
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
