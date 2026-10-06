import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, FileText, ImagePlus } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { api, assetUrl, uploadAsset } from '@/lib/api'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import type { CanvasDetail } from '@/lib/types'

type Preview = { file: File; url: string }

export function PublicationDialog({
  open,
  canvas,
  onClose,
  onBack,
}: {
  open: boolean
  canvas: CanvasDetail | null
  onClose: () => void
  onBack: () => void
}) {
  const workInput = useRef<HTMLInputElement>(null)
  const coverInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [shareWorkflow, setShareWorkflow] = useState(true)
  const [work, setWork] = useState<Preview | null>(null)
  const [cover, setCover] = useState<Preview | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) setTitle(canvas?.canvas.name ?? '')
  }, [canvas?.canvas.name, open])

  useEffect(() => () => {
    if (work) URL.revokeObjectURL(work.url)
    if (cover) URL.revokeObjectURL(cover.url)
  }, [work, cover])

  const selectFile = (file: File | undefined, type: 'work' | 'cover') => {
    if (!file) return
    const setPreview = type === 'work' ? setWork : setCover
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url)
      return { file, url: URL.createObjectURL(file) }
    })
  }

  const submit = async () => {
    if (!canvas || !title.trim() || !description.trim()) return
    setSubmitting(true)
    try {
      const [workAsset, coverAsset] = await Promise.all([
        work ? uploadAsset(work.file, mediaAssetType(work.file), canvas.canvas.id) : undefined,
        cover ? uploadAsset(cover.file, 'image', canvas.canvas.id) : undefined,
      ])
      await api('/publications', {
        method: 'POST',
        body: JSON.stringify({
          canvasId: canvas.canvas.id,
          title: title.trim(),
          description: description.trim(),
          previewAssetUrl: workAsset && assetUrl((workAsset as { url?: string }).url),
          previewAssetType: workAsset && (workAsset as { assetType?: string }).assetType,
          thumbnailUrl: coverAsset && assetUrl((coverAsset as { url?: string }).url),
          shareWorkflow,
        }),
      })
      toastSuccess('作品已提交审核，通过后将在创意广场展示')
      onClose()
    } catch (error) {
      toastError((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(title.trim() && description.trim() && !submitting)

  return (
    <Modal
      open={open}
      onClose={onClose}
      hideHeader
      size="publication"
      className="max-h-[94vh] overflow-y-auto rounded-[32px] p-6 sm:p-12"
    >
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-[52px] items-center gap-2 rounded-full border border-black/10 bg-[#f3f3f3] px-5 text-[17px] font-medium text-[#222] transition hover:bg-[#ebebeb]"
      >
        <ArrowLeft size={22} strokeWidth={2} /> 返回
      </button>

      <div className="mb-7 -mt-10 text-center sm:mb-8">
        <h2 className="text-[30px] font-black tracking-[-0.03em] text-[#111]">提交作品到 Paper TV</h2>
        <p className="mx-auto mt-1 max-w-2xl text-[18px] leading-8 text-[#858585]">
          补充作品信息并提交审核。审核通过后公开展示，并计入 Paper TV 奖励任务。<br />
          请认真填写项目名称与作品描述，这将显著影响审核结果。
        </p>
      </div>

      <div className="grid gap-x-7 gap-y-5 lg:grid-cols-2">
        <div className="space-y-5">
          <FieldLabel>项目名称（必填）</FieldLabel>
          <input
            value={title}
            maxLength={128}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="请输入项目名字"
            className="h-[67px] w-full rounded-[20px] border border-black/10 bg-white px-5 text-[18px] text-[#222] outline-none placeholder:text-[#aaa] focus:border-black/30"
          />

          <div>
            <FieldLabel>作品描述（必填）</FieldLabel>
            <textarea
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="用两三句话介绍作品内容、创作亮点与使用场景"
              className="mt-3 h-[140px] w-full resize-none rounded-[20px] border border-black/10 bg-white px-5 py-4 text-[18px] leading-7 text-[#222] outline-none placeholder:text-[#aaa] focus:border-black/30"
            />
          </div>

          <div className="rounded-[28px] border border-black/10 bg-[#f1f1f1] px-6 py-5">
            <div className="flex items-center justify-between gap-5">
              <div>
                <p className="text-[18px] font-extrabold text-[#141414]">是否共享画布</p>
                <p className="mt-1 text-[16px] text-[#888]">开启后，其他人可以查看并克隆该作品的创作画布。</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={shareWorkflow}
                onClick={() => setShareWorkflow((value) => !value)}
                className={`relative h-10 w-[70px] shrink-0 rounded-full border-2 transition ${shareWorkflow ? 'border-[#111] bg-[#111]' : 'border-[#d1d1d1] bg-[#d1d1d1]'}`}
              >
                <span className={`absolute top-1 h-7 w-7 rounded-full bg-white shadow transition-transform ${shareWorkflow ? 'translate-x-8' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <UploadPreview
            label="作品文件"
            preview={work}
            emptyIcon={<FileText size={40} strokeWidth={2.2} />}
            emptyText="选择作品文件后在此预览"
            accept="image/*,video/*,audio/*"
            inputRef={workInput}
            onSelect={(file) => selectFile(file, 'work')}
            onClick={() => workInput.current?.click()}
            media
          />
          <UploadPreview
            label="封面"
            preview={cover}
            emptyIcon={<ImagePlus size={40} strokeWidth={2.2} />}
            emptyText="选择封面图片后在此预览"
            accept="image/*"
            inputRef={coverInput}
            onSelect={(file) => selectFile(file, 'cover')}
            onClick={() => coverInput.current?.click()}
          />
        </div>
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="mt-7 h-[67px] w-full rounded-[20px] bg-[#111] text-[18px] font-extrabold text-white transition hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:bg-[#969696]"
      >
        {submitting ? '提交中…' : '提交审核'}
      </button>
    </Modal>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-[18px] font-extrabold text-[#777]">{children}</label>
}

function UploadPreview({
  label,
  preview,
  emptyIcon,
  emptyText,
  accept,
  inputRef,
  onSelect,
  onClick,
  media,
}: {
  label: string
  preview: Preview | null
  emptyIcon: React.ReactNode
  emptyText: string
  accept: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onSelect: (file: File | undefined) => void
  onClick: () => void
  media?: boolean
}) {
  const isVideo = media && preview?.file.type.startsWith('video/')
  const isAudio = media && preview?.file.type.startsWith('audio/')
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => onSelect(event.target.files?.[0])}
      />
      <button
        type="button"
        onClick={onClick}
        className="mt-3 flex h-[272px] w-full overflow-hidden rounded-[28px] border border-black/10 bg-[#f0f0f0] text-left"
      >
        {preview ? (
          isVideo ? <video src={preview.url} className="h-full w-full object-cover" muted />
            : isAudio ? <audio src={preview.url} className="m-auto w-4/5" controls />
              : <img src={preview.url} alt={label} className="h-full w-full object-cover" />
        ) : (
          <span className="m-auto flex flex-col items-center gap-3 text-[#858585]">
            {emptyIcon}
            <span className="text-[16px]">{emptyText}</span>
          </span>
        )}
      </button>
    </div>
  )
}

function mediaAssetType(file: File) {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'image'
}
