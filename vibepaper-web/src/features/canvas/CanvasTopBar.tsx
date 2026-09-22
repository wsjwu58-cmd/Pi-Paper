import {
  Bot,
  Check,
  ChevronDown,
  CreditCard,
  Download,
  Gift,
  HelpCircle,
  Library,
  Link,
  Megaphone,
  Share2,
  Undo2,
  Upload,
  Users,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { sid } from '@/lib/ids'
import { useAuth } from '@/lib/auth'
import { useCanvasStore } from './canvasStore'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import { PublicationDialog } from './PublicationDialog'

export function CanvasTopBar() {
  const nav = useNavigate()
  const canvas = useCanvasStore((s) => s.canvas)
  const saving = useCanvasStore((s) => s.saving)
  const dirty = useCanvasStore((s) => s.dirty)
  const setAssetOpen = useCanvasStore((s) => s.setAssetOpen)
  const setAccountPanel = useCanvasStore((s) => s.setAccountPanel)
  const assetOpen = useCanvasStore((s) => s.assetOpen)
  const agentOpen = useCanvasStore((s) => s.agentOpen)
  const rightOffset = 'right-4'
  const setAgentOpen = useCanvasStore((s) => s.setAgentOpen)
  const user = useAuth((s) => s.user)
  const account = useAuth((s) => s.account)
  const refreshAccount = useAuth((s) => s.refreshAccount)
  const [shareOpen, setShareOpen] = useState(false)
  const [publicationOpen, setPublicationOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const accountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refreshAccount()
  }, [refreshAccount])

  useEffect(() => {
    const openSub = () => {
      setAccountOpen(true)
      setAccountPanel('subscription')
    }
    window.addEventListener('vp-open-subscription', openSub)
    return () => window.removeEventListener('vp-open-subscription', openSub)
  }, [setAccountPanel])

  useEffect(() => {
    if (!accountOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [accountOpen])

  const onExport = async () => {
    if (!canvas) return
    try {
      const doc = await api<Record<string, unknown>>(
        `/canvases/${sid(canvas.canvas.id)}/export`,
        { method: 'POST' },
      )
      const a = document.createElement('a')
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
      )
      a.download = `${canvas.canvas.name}.json`
      a.click()
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const onImport = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      void api('/canvases/import', { method: 'POST', body: String(reader.result) })
        .then((c) => {
          toastSuccess('导入成功')
          nav(`/canvas/${sid((c as { canvas: { id: string | number } }).canvas.id)}`)
        })
        .catch((e) => toastError((e as Error).message))
    }
    reader.readAsText(file)
  }

  const onShare = async (visibility: string) => {
    if (!canvas) return
    try {
      const d = await api<{ canvas: { shareToken: string; visibility: string } }>(
        `/canvases/${sid(canvas.canvas.id)}/share`,
        { method: 'POST', body: JSON.stringify({ visibility }) },
      )
      toastSuccess(`共享状态：${visibility}`)
      if (visibility === 'link' || visibility === 'public') {
        void navigator.clipboard?.writeText(
          `${location.origin}/canvas/shared/${d.canvas.shareToken}`,
        )
      }
      setShareOpen(false)
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  return (
    <>
      {/* Left: dark canvas title pill */}
      <div className="pointer-events-auto absolute left-4 top-4 z-30">
        <div className="flex h-11 items-center gap-2 rounded-[18px] bg-[#1a1a1b] px-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
          <button
            type="button"
            onClick={() => nav('/workspace')}
            className="rounded-full p-2.5 text-white/70 hover:bg-white/10 hover:text-white"
            title="返回管理空间"
          >
            <Undo2 size={16} />
          </button>
          <div className="min-w-0 pr-2">
            <p className="max-w-48 truncate text-[14px] font-bold text-white">
              {canvas?.canvas.name ?? '加载中…'}
            </p>
            <p className="text-[11px] text-white/50">
              {saving ? (
                '保存中…'
              ) : dirty ? (
                '有未保存修改'
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <Check size={11} /> 已同步
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Right: light action pill */}
      <div
        className={`pointer-events-auto absolute top-4 z-30 flex items-center gap-2 transition-[right] ${rightOffset}`}
      >
        <div
          ref={accountRef}
          className="relative flex h-11 items-center gap-1 rounded-[18px] border border-black/6 bg-white/95 px-1.5 shadow-[0_12px_40px_rgba(15,23,42,0.10)] backdrop-blur"
        >
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            className="flex items-center gap-2 rounded-full px-1.5 py-1 hover:bg-black/[0.04]"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#111] text-[12px] font-bold text-white">
              {(user?.nickname ?? 'U').slice(0, 1)}
            </div>
            <div className="hidden text-left sm:block">
              <p className="text-[13px] font-bold leading-tight text-[#111]">
                {user?.nickname ?? '账户'}
              </p>
              <p className="text-[11px] font-semibold text-[#666]">
                {account?.availablePoints ?? 0} 点
              </p>
            </div>
            <ChevronDown size={13} className="text-[#999]" />
          </button>

          <div className="mx-1 h-5 w-px bg-black/8" />

          <TopIconButton
            title="Agent"
            active={agentOpen}
            onClick={() => setAgentOpen(!agentOpen)}
          >
            <Bot size={17} />
          </TopIconButton>
          <TopIconButton
            title="素材库"
            active={assetOpen}
            onClick={() => setAssetOpen(!assetOpen)}
          >
            <Library size={17} />
          </TopIconButton>

          <TopIconButton title="分享与发布" onClick={() => setShareOpen(true)}>
            <Share2 size={17} />
          </TopIconButton>

          <Modal open={shareOpen} onClose={() => setShareOpen(false)} hideHeader>
            <div className="flex flex-col items-center py-2 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#f3f4f6]">
                <Share2 size={24} className="text-[#111]" />
              </div>
              <h2 className="text-[22px] font-bold text-[#111827]">分享画布</h2>
              <p className="mb-6 text-[14px] text-[#6b7280]">选择共享方式，让他人查看或协作你的创作</p>

              <div className="w-full space-y-3">
                {(
                  [
                    ['private', '私密', '仅自己可见'],
                    ['link', '仅链接', '任何获得链接的人可查看'],
                    ['public', '公开', '在创意广场展示'],
                  ] as const
                ).map(([v, title, desc]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => void onShare(v)}
                    className={cn(
                      'flex w-full items-center gap-4 rounded-[20px] border p-4 text-left transition hover:border-[#111]/30',
                      canvas?.canvas.visibility === v
                        ? 'border-[#111] bg-[#fafafa]'
                        : 'border-[#f3f4f6] bg-white',
                    )}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f3f4f6]">
                      {v === 'private' ? (
                        <span className="text-[16px]">🔒</span>
                      ) : v === 'link' ? (
                        <Link size={18} className="text-[#666]" />
                      ) : (
                        <span className="text-[16px]">🌐</span>
                      )}
                    </span>
                    <div className="flex-1">
                      <p className="text-[16px] font-bold text-[#111827]">{title}</p>
                      <p className="text-[13px] text-[#6b7280]">{desc}</p>
                    </div>
                    {canvas?.canvas.visibility === v && <Check size={18} className="text-[#111]" />}
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => {
                    setShareOpen(false)
                    setPublicationOpen(true)
                  }}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-[20px] bg-[#111] py-3 text-[14px] font-bold text-white"
                >
                  <Share2 size={16} /> 分享到创意广场
                </button>
              </div>
            </div>
          </Modal>

          <PublicationDialog
            open={publicationOpen}
            canvas={canvas}
            onClose={() => setPublicationOpen(false)}
            onBack={() => {
              setPublicationOpen(false)
              setShareOpen(true)
            }}
          />

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
          <TopIconButton title="导出画布" onClick={() => void onExport()}>
            <Download size={17} />
          </TopIconButton>
          <TopIconButton title="导入画布" onClick={() => fileRef.current?.click()}>
            <Upload size={17} />
          </TopIconButton>
          <TopIconButton title="帮助" onClick={() => toastSuccess('帮助文档即将上线')}>
            <HelpCircle size={17} />
          </TopIconButton>

          {accountOpen ? (
            <div className="absolute right-0 top-12 z-40 w-56 overflow-hidden rounded-[18px] border border-black/8 bg-white py-1.5 shadow-xl">
              <p className="px-3.5 pb-1 pt-1.5 text-[11px] font-bold tracking-wide text-[#999]">
                账户与权益
              </p>
              {(
                [
                  ['subscription', '订阅菜单', CreditCard],
                  ['rewards', '奖励中心', Gift],
                  ['invites', '邀请中心', Users],
                  ['announcements', '公告', Megaphone],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setAccountPanel(key)
                    setAccountOpen(false)
                  }}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] font-semibold text-[#333] hover:bg-black/[0.04]"
                >
                  <Icon size={16} className="text-[#666]" />
                  {label}
                </button>
              ))}
              <div className="my-1 h-px bg-black/8" />
              <button
                type="button"
                onClick={() => {
                  setAccountOpen(false)
                  nav('/profile')
                }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] font-semibold text-[#333] hover:bg-black/[0.04]"
              >
                个人中心
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

function TopIconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-full p-2 transition',
        active
          ? 'bg-[#111] text-white'
          : 'text-[#666] hover:bg-black/5 hover:text-[#111]',
      )}
    >
      {children}
    </button>
  )
}
