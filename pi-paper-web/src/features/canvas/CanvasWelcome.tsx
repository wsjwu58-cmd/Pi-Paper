import { Type, Image, Video, Mic, Clapperboard, Sparkles } from 'lucide-react'
import { OrigamiBird } from '@/components/OrigamiBird'
import { cn } from '@/lib/cn'

const WELCOME_CARDS = [
  {
    id: 'text-to-video',
    type: 'video',
    label: '文生视频',
    sub: 'Text to Video',
    desc: '输入创意描述，直接生成动态影像',
    icon: Video,
    bg: '#e8e8e8',
  },
  {
    id: 'image-gen',
    type: 'image',
    label: '图片生成',
    sub: 'Image Generation',
    desc: '从文字到视觉，一键出图',
    icon: Image,
    bg: '#dedede',
  },
  {
    id: 'audio',
    type: 'audio',
    label: '音频创作',
    sub: 'Audio Creation',
    desc: '生成背景音乐、配音与音效',
    icon: Mic,
    bg: '#d4d4d4',
  },
  {
    id: 'text',
    type: 'text',
    label: '文本创作',
    sub: 'Text Creation',
    desc: '剧本、文案、角色设定与世界观',
    icon: Type,
    bg: '#e0e0e0',
  },
  {
    id: 'compose',
    type: 'compose',
    label: '合成导演',
    sub: 'Compose & Director',
    desc: '多镜剪辑、导演台与最终合成',
    icon: Clapperboard,
    bg: '#d8d8d8',
  },
]

export function CanvasWelcome({ onCreate, availableTypes }: { onCreate: (type: string) => void; availableTypes?: string[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-auto flex w-full max-w-3xl flex-col items-center">
        <div className="mb-10 flex flex-col items-center gap-4">
          <OrigamiBird className="h-14 w-auto text-black/90" />
          <h1 className="text-center text-[34px] font-bold tracking-tight text-[#111111] sm:text-[44px]">
            今天想创作什么？
          </h1>
        </div>

        <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {WELCOME_CARDS.map((card, idx) => {
            const Icon = card.icon
            const isBottom = idx >= 3
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => onCreate(card.type)}
                disabled={availableTypes !== undefined && !availableTypes.includes(card.type)}
                title={availableTypes !== undefined && !availableTypes.includes(card.type) ? '桌面版暂不可用' : undefined}
                className={cn(
                  'group relative flex flex-col items-start rounded-[24px] p-5 text-left transition-all duration-200 hover:scale-[1.02] hover:shadow-lg active:scale-[0.99] disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none',
                  isBottom && 'sm:col-span-2 lg:col-span-1',
                  idx === 3 && 'lg:col-start-2',
                )}
                style={{ backgroundColor: card.bg }}
              >
                <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-white/90 text-black shadow-sm">
                  <Icon size={20} strokeWidth={1.8} />
                </span>
                <p className="text-[17px] font-bold text-[#111111]">{card.label}</p>
                <p className="mt-0.5 text-[12px] font-medium text-[#666666]">{card.sub}</p>
                <p className="mt-3 text-[13px] leading-relaxed text-[#555555]">{card.desc}</p>
                <span className="absolute right-4 top-4 opacity-0 transition-opacity group-hover:opacity-100">
                  <Sparkles size={16} className="text-black/40" />
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
