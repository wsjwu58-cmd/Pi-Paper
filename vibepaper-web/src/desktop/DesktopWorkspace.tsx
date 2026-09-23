import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  Position,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { DesktopAsset, DesktopCanvas, DesktopProject } from './desktop-bridge'

const bridge = window.vibepaperDesktop

export function DesktopWorkspace() {
  const [project, setProject] = useState<DesktopProject | null>(null)
  const [canvas, setCanvas] = useState<DesktopCanvas | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const activateProject = useCallback(async (nextProject: DesktopProject | null) => {
    if (!nextProject) return
    setLoading(true)
    setError('')
    setProject(nextProject)
    setCanvas(null)
    try {
      const loadedCanvas = await bridge?.loadCanvas(nextProject.projectId, nextProject.canvasId)
      if (!loadedCanvas) throw new Error('桌面项目接口不可用。')
      setCanvas(loadedCanvas)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取项目画布。')
      setProject(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void bridge?.getActiveProject().then(async (activeProject) => {
      if (!cancelled && activeProject) await activateProject(activeProject)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '无法恢复上次打开的项目。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [activateProject])

  const createProject = async (name: string) => {
    setError('')
    try {
      await activateProject(await bridge?.createProject(name) ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建项目。')
    }
  }

  const openProject = async () => {
    setError('')
    try {
      await activateProject(await bridge?.openProject() ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开项目。')
    }
  }

  if (loading) return <LoadingScreen />
  if (!project || !canvas) {
    return <ProjectPicker error={error} onCreate={createProject} onOpen={openProject} />
  }
  return (
    <ReactFlowProvider>
      <LocalCanvas
        key={project.projectId}
        project={project}
        initialCanvas={canvas}
        error={error}
        onOpenProject={openProject}
        onProjectRestored={activateProject}
      />
    </ReactFlowProvider>
  )
}

function TextNode({ id, data }: NodeProps<Node<{ label?: string }>>) {
  const updateText = useContext(TextNodeContext)
  const label = typeof data.label === 'string' ? data.label : ''
  return (
    <div className="relative min-w-[240px] overflow-visible rounded-2xl border border-black/12 bg-white shadow-[0_6px_20px_rgba(0,0,0,0.08)]">
      <div className="border-b border-black/8 px-3 py-2 text-[11px] font-bold text-[#777]">文本</div>
      <textarea
        aria-label="文本节点内容"
        className="nodrag nowheel block min-h-24 w-full resize-y bg-transparent px-3 py-2 text-sm leading-6 text-[#222] outline-none"
        value={label}
        maxLength={20_000}
        placeholder="输入文本内容…"
        onChange={(event) => updateText(id, event.target.value)}
        onBlur={(event) => updateText(id, event.currentTarget.value, true)}
      />
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#8a72e8]" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#8a72e8]" />
    </div>
  )
}

function ImageNode({ data }: NodeProps<Node<{ assetId?: string; name?: string }>>) {
  const [imageUnavailable, setImageUnavailable] = useState(false)
  const assetId = typeof data.assetId === 'string' ? data.assetId : ''
  return (
    <div className="relative w-[260px] overflow-visible rounded-2xl border border-black/12 bg-white p-2 shadow-[0_6px_20px_rgba(0,0,0,0.08)]">
      {assetId && !imageUnavailable
        ? <img className="pointer-events-none max-h-[220px] w-full rounded-xl object-contain" src={`vibe://app/assets/${assetId}`} alt={typeof data.name === 'string' ? data.name : '本地图片素材'} draggable={false} onError={() => setImageUnavailable(true)} />
        : <div className="flex h-32 items-center justify-center text-xs text-[#888]">素材不可用</div>}
      <p className="mt-2 truncate px-1 text-[11px] text-[#777]">{typeof data.name === 'string' ? data.name : '图片素材'}</p>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#8a72e8]" />
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#8a72e8]" />
    </div>
  )
}

const TextNodeContext = createContext<(id: string, label: string, immediate?: boolean) => void>(() => {})
const nodeTypes = { text: TextNode, image: ImageNode }

function LoadingScreen() {
  return <div className="flex min-h-screen items-center justify-center bg-[#f7f7f8] text-sm text-[#666]">正在打开本地项目…</div>
}

function ProjectPicker({
  error,
  onCreate,
  onOpen,
}: {
  error: string
  onCreate: (name: string) => Promise<void>
  onOpen: () => Promise<void>
}) {
  const [name, setName] = useState('我的项目')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      await onCreate(name)
    } finally {
      setBusy(false)
    }
  }

  const open = async () => {
    setBusy(true)
    try {
      await onOpen()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f8] px-6 text-[#171717]">
      <section className="w-full max-w-lg rounded-3xl border border-black/8 bg-white p-8 shadow-[0_18px_60px_rgba(0,0,0,0.08)]">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8a72e8]">VibePaper Desktop</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight">从本地项目开始</h1>
        <p className="mt-3 text-sm leading-6 text-[#666]">项目、画布和后续生成内容保存在你选择的本机文件夹中。</p>
        <form className="mt-8" onSubmit={(event) => { event.preventDefault(); void create() }}>
          <label htmlFor="project-name" className="text-sm font-semibold">新项目名称</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            className="mt-2 h-11 w-full rounded-xl border border-black/12 px-3 text-sm outline-none focus:border-[#8a72e8]"
          />
          <button disabled={busy || !name.trim()} className="mt-3 h-11 w-full rounded-xl bg-[#171717] text-sm font-bold text-white disabled:opacity-50">
            {busy ? '请稍候…' : '创建本地项目'}
          </button>
        </form>
        <button onClick={() => void open()} disabled={busy} className="mt-3 h-11 w-full rounded-xl border border-black/12 text-sm font-bold disabled:opacity-50">
          打开已有项目
        </button>
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </section>
    </main>
  )
}

function LocalCanvas({
  project,
  initialCanvas,
  error,
  onOpenProject,
  onProjectRestored,
}: {
  project: DesktopProject
  initialCanvas: DesktopCanvas
  error: string
  onOpenProject: () => Promise<void>
  onProjectRestored: (project: DesktopProject | null) => Promise<void>
}) {
  const [nodes, setNodes] = useState<Node[]>(initialCanvas.nodes)
  const [edges, setEdges] = useState<Edge[]>(initialCanvas.edges)
  const [assets, setAssets] = useState<DesktopAsset[]>([])
  const [assetError, setAssetError] = useState('')
  const [assetPending, setAssetPending] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [saveError, setSaveError] = useState('')
  const [backupMessage, setBackupMessage] = useState('')
  const [backupPending, setBackupPending] = useState(false)
  const [restorePending, setRestorePending] = useState(false)
  const version = useRef(initialCanvas.version)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const saveFailure = useRef<string | null>(null)

  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  useEffect(() => {
    let cancelled = false
    void bridge?.listAssets(project.projectId).then((items) => {
      if (!cancelled) setAssets(items)
    }).catch((cause: unknown) => {
      if (!cancelled) setAssetError(cause instanceof Error ? cause.message : '无法读取本地素材。')
    })
    return () => { cancelled = true }
  }, [project.projectId])

  const persist = useCallback((nextNodes: Node[], nextEdges: Edge[]) => {
    if (!bridge) return
    setSaveState('saving')
    setSaveError('')
    saveFailure.current = null
    saveQueue.current = saveQueue.current.then(async () => {
      const result = await bridge.saveCanvas({
        projectId: project.projectId,
        canvasId: project.canvasId,
        expectedVersion: version.current,
        nodes: nextNodes,
        edges: nextEdges,
      })
      version.current = result.version
      saveFailure.current = null
      setSaveState('saved')
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : '保存画布失败。'
      saveFailure.current = message
      setSaveState('error')
      setSaveError(message)
    })
  }, [project.canvasId, project.projectId])

  const schedulePersist = useCallback((nextNodes: Node[], nextEdges: Edge[], immediate = false) => {
    if (timer.current) clearTimeout(timer.current)
    if (immediate) {
      timer.current = null
      persist(nextNodes, nextEdges)
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      persist(nodesRef.current, edgesRef.current)
    }, 400)
  }, [persist])

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const next = applyNodeChanges(changes, nodesRef.current)
    nodesRef.current = next
    setNodes(next)
    if (changes.some((change) => change.type === 'position' || change.type === 'remove' || change.type === 'add' || change.type === 'replace')) {
      schedulePersist(next, edgesRef.current)
    }
  }, [schedulePersist])

  const updateText = useCallback((id: string, label: string, immediate = false) => {
    const next = nodesRef.current.map((node) => node.id === id
      ? { ...node, data: { ...node.data, label } }
      : node)
    nodesRef.current = next
    setNodes(next)
    schedulePersist(next, edgesRef.current, immediate)
  }, [schedulePersist])

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    const next = applyEdgeChanges(changes, edgesRef.current)
    edgesRef.current = next
    setEdges(next)
    if (changes.some((change) => change.type === 'remove' || change.type === 'add')) {
      schedulePersist(nodesRef.current, next)
    }
  }, [schedulePersist])

  const handleConnect = useCallback((connection: Connection) => {
    const next = addEdge(connection, edgesRef.current)
    edgesRef.current = next
    setEdges(next)
    schedulePersist(nodesRef.current, next, true)
  }, [schedulePersist])

  const addTextNode = () => {
    const next = [...nodesRef.current, {
      id: crypto.randomUUID(),
      type: 'text',
      position: { x: 160 + nodesRef.current.length * 24, y: 120 + nodesRef.current.length * 24 },
      data: { label: '' },
    }]
    nodesRef.current = next
    setNodes(next)
    schedulePersist(next, edgesRef.current, true)
  }

  const addImageNode = (asset: DesktopAsset) => {
    const next = [...nodesRef.current, {
      id: crypto.randomUUID(),
      type: 'image',
      position: { x: 160 + nodesRef.current.length * 24, y: 120 + nodesRef.current.length * 24 },
      data: { assetId: asset.assetId, name: asset.name },
    }]
    nodesRef.current = next
    setNodes(next)
    schedulePersist(next, edgesRef.current, true)
  }

  const importImage = async () => {
    if (assetPending) return
    setAssetPending(true)
    setAssetError('')
    try {
      const imported = await bridge?.importImage(project.projectId)
      if (imported) setAssets((current) => [imported, ...current.filter((asset) => asset.assetId !== imported.assetId)])
    } catch (cause) {
      setAssetError(cause instanceof Error ? cause.message : '导入本地图片失败。')
    } finally {
      setAssetPending(false)
    }
  }

  const openOtherProject = async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      persist(nodesRef.current, edgesRef.current)
    }
    await saveQueue.current
    if (saveFailure.current) return
    await onOpenProject()
  }

  const createBackup = async () => {
    if (backupPending) return
    setBackupPending(true)
    setBackupMessage('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await saveQueue.current
      if (saveFailure.current) {
        setBackupMessage(saveFailure.current)
        return
      }
      const backup = await bridge?.backupProject(project.projectId)
      if (backup) setBackupMessage(`备份完成：${backup.name}`)
    } catch (cause) {
      setBackupMessage(cause instanceof Error ? cause.message : '创建项目备份失败。')
    } finally {
      setBackupPending(false)
    }
  }

  const restoreBackup = async () => {
    if (restorePending || backupPending || assetPending) return
    setRestorePending(true)
    setBackupMessage('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await saveQueue.current
      if (saveFailure.current) {
        setBackupMessage(saveFailure.current)
        return
      }
      const restored = await bridge?.restoreBackup()
      if (restored) await onProjectRestored(restored)
    } catch (cause) {
      setBackupMessage(cause instanceof Error ? cause.message : '恢复项目备份失败。')
    } finally {
      setRestorePending(false)
    }
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return (
    <main className="flex h-screen flex-col bg-[#f7f7f8] text-[#171717]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-black/8 bg-white px-5">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{project.name}</p>
          <p className="text-[11px] text-[#888]">本地项目</p>
        </div>
        <div className="flex items-center gap-3">
          {backupMessage && <span className="max-w-[360px] truncate text-xs text-[#777]" role="status" title={backupMessage}>{backupMessage}</span>}
          <span className={`max-w-[360px] truncate text-xs ${saveState === 'error' ? 'text-red-600' : 'text-[#777]'}`} role={saveError ? 'alert' : undefined} title={saveError || undefined}>
            {saveState === 'saving' ? '保存中…' : saveState === 'error' ? saveError : '已保存'}
          </span>
          <button onClick={() => void createBackup()} disabled={backupPending || restorePending} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold disabled:opacity-50">{backupPending ? '正在备份…' : '备份项目'}</button>
          <button onClick={() => void restoreBackup()} disabled={backupPending || restorePending || assetPending} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold disabled:opacity-50">{restorePending ? '正在恢复…' : '恢复备份副本'}</button>
          <button onClick={addTextNode} className="rounded-lg bg-[#171717] px-3 py-2 text-xs font-bold text-white">添加文本节点</button>
          <button onClick={() => void openOtherProject()} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">切换项目</button>
        </div>
      </header>
      <div className="flex min-h-16 shrink-0 items-center gap-3 overflow-x-auto border-b border-black/8 bg-white px-5 py-2">
        <button onClick={() => void importImage()} disabled={assetPending} className="shrink-0 rounded-lg bg-[#eeeafc] px-3 py-2 text-xs font-bold text-[#6d55c9] disabled:opacity-50">
          {assetPending ? '正在导入…' : '导入图片'}
        </button>
        {assets.length === 0
          ? <span className="whitespace-nowrap text-xs text-[#888]">图片素材会复制到当前本地项目。</span>
          : assets.map((asset) => (
            <button key={asset.assetId} onClick={() => addImageNode(asset)} title={`${asset.name} · ${asset.referenceCount} 个引用`} className="flex h-12 shrink-0 items-center gap-2 rounded-lg border border-black/8 px-2 hover:bg-[#f7f7f8]">
              <img src={`vibe://app/assets/${asset.assetId}`} alt="" className="h-8 w-8 rounded object-cover" />
              <span className="max-w-32 truncate text-xs">{asset.name}</span>
            </button>
          ))}
        {assetError && <span role="alert" className="max-w-72 truncate text-xs text-red-600" title={assetError}>{assetError}</span>}
      </div>
      {error && <p role="alert" className="shrink-0 border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">{error}</p>}
      <section className="relative min-h-0 flex-1">
        <TextNodeContext.Provider value={updateText}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onNodeDragStop={() => schedulePersist(nodesRef.current, edgesRef.current, true)}
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background color="#d8d8dd" gap={22} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </TextNodeContext.Provider>
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-[#888]">
            画布已保存在本地。添加一个文本节点开始创作。
          </div>
        )}
      </section>
    </main>
  )
}
