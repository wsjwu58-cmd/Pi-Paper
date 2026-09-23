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
import type { DesktopAsset, DesktopCanvas, DesktopLocalTextModel, DesktopProject, DesktopTask } from './desktop-bridge'

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
  const actions = useContext(TextNodeContext)
  const label = typeof data.label === 'string' ? data.label : ''
  return (
    <div className="relative min-w-[240px] overflow-visible rounded-2xl border border-black/12 bg-white shadow-[0_6px_20px_rgba(0,0,0,0.08)]">
      <div className="flex items-center justify-between border-b border-black/8 px-3 py-2">
        <span className="text-[11px] font-bold text-[#777]">文本</span>
        <button
          className="nodrag rounded-md bg-[#eeeafc] px-2 py-1 text-[10px] font-bold text-[#6d55c9] disabled:opacity-50"
          disabled={actions.pendingNodeId === id || (actions.modelAvailable && !label.trim())}
          onClick={() => actions.generateText(id, label)}
        >
          {actions.pendingNodeId === id ? '正在提交…' : actions.modelAvailable ? '生成文本' : '配置模型'}
        </button>
      </div>
      <textarea
        aria-label="文本节点内容"
        className="nodrag nowheel block min-h-24 w-full resize-y bg-transparent px-3 py-2 text-sm leading-6 text-[#222] outline-none"
        value={label}
        maxLength={20_000}
        placeholder="输入文本内容…"
        onChange={(event) => actions.updateText(id, event.target.value)}
        onBlur={(event) => actions.updateText(id, event.currentTarget.value, true)}
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

interface TextNodeContextValue {
  updateText: (id: string, label: string, immediate?: boolean) => void
  generateText: (id: string, prompt: string) => void
  pendingNodeId: string | null
  modelAvailable: boolean
}

const TextNodeContext = createContext<TextNodeContextValue>({
  updateText: () => {},
  generateText: () => {},
  pendingNodeId: null,
  modelAvailable: false,
})
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
  const [tasksOpen, setTasksOpen] = useState(false)
  const [tasks, setTasks] = useState<DesktopTask[]>([])
  const [taskError, setTaskError] = useState('')
  const [cancellingTask, setCancellingTask] = useState<string | null>(null)
  const [submittingNode, setSubmittingNode] = useState<string | null>(null)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [localTextModel, setLocalTextModel] = useState<DesktopLocalTextModel | null>(null)
  const [modelLoadError, setModelLoadError] = useState('')
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
  useEffect(() => {
    let cancelled = false
    void bridge?.getLocalTextModel().then((config) => {
      if (!cancelled) {
        setLocalTextModel(config)
        setModelLoadError('')
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setModelLoadError(cause instanceof Error ? cause.message : '无法读取本地模型配置。')
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!tasksOpen || !bridge) return
    let cancelled = false
    let loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const items = await bridge.listTasks(project.projectId, 100)
        if (!cancelled) {
          setTasks(items)
        }
      } catch (cause) {
        if (!cancelled) setTaskError(cause instanceof Error ? cause.message : '无法读取本地任务记录。')
      } finally {
        loading = false
      }
    }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 2500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [project.projectId, tasksOpen])

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

  const insertTextNode = (label: string) => {
    if (label.length > 20_000) {
      setTaskError('生成结果超过单个文本节点的长度上限。')
      setTasksOpen(true)
      return
    }
    const next = [...nodesRef.current, {
      id: crypto.randomUUID(),
      type: 'text',
      position: { x: 160 + nodesRef.current.length * 24, y: 120 + nodesRef.current.length * 24 },
      data: { label },
    }]
    nodesRef.current = next
    setNodes(next)
    schedulePersist(next, edgesRef.current, true)
  }

  const addTextNode = () => insertTextNode('')

  const generateText = async (nodeId: string, prompt: string) => {
    if (!localTextModel) {
      setModelSettingsOpen(true)
      return
    }
    if (!bridge || submittingNode || !prompt.trim()) return
    setSubmittingNode(nodeId)
    setTaskError('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        schedulePersist(nodesRef.current, edgesRef.current, true)
      }
      await saveQueue.current
      if (saveFailure.current) throw new Error(saveFailure.current)
      await bridge.createTextTask({
        projectId: project.projectId,
        canvasId: project.canvasId,
        canvasVersion: version.current,
        nodeId,
        prompt,
        idempotencyKey: crypto.randomUUID(),
      })
      setTasksOpen(true)
    } catch (cause) {
      setTaskError(cause instanceof Error ? cause.message : '无法提交本地文本任务。')
      setTasksOpen(true)
    } finally {
      setSubmittingNode(null)
    }
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

  const cancelQueuedTask = async (task: DesktopTask) => {
    if (task.status !== 'queued' || cancellingTask) return
    setCancellingTask(task.taskId)
    setTaskError('')
    try {
      await bridge?.cancelTask(project.projectId, task.taskId)
      const items = await bridge?.listTasks(project.projectId, 100)
      if (items) setTasks(items)
    } catch (cause) {
      setTaskError(cause instanceof Error ? cause.message : '无法取消此任务。')
    } finally {
      setCancellingTask(null)
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
          <button onClick={() => { setTaskError(''); setTasksOpen(true) }} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">任务记录</button>
          <button onClick={() => setModelSettingsOpen(true)} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">
            {localTextModel ? '本地文本模型已配置' : '配置本地文本模型'}
          </button>
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
        <TextNodeContext.Provider value={{
          updateText,
          generateText: (nodeId, prompt) => { void generateText(nodeId, prompt) },
          pendingNodeId: submittingNode,
          modelAvailable: localTextModel !== null,
        }}>
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
      {tasksOpen && (
        <TaskHistoryPanel
          tasks={tasks}
          error={taskError}
          cancellingTask={cancellingTask}
          onCancel={(task) => void cancelQueuedTask(task)}
          onReadOutput={(taskId) => bridge?.readTaskOutput(project.projectId, taskId) ?? Promise.reject(new Error('桌面任务接口不可用。'))}
          onInsertOutput={(text) => insertTextNode(text)}
          onClose={() => setTasksOpen(false)}
        />
      )}
      {modelSettingsOpen && (
        <LocalTextModelSettings
          initialConfig={localTextModel}
          loadError={modelLoadError}
          onSaved={(config) => {
            setLocalTextModel(config)
            setModelLoadError('')
            setModelSettingsOpen(false)
          }}
          onCleared={() => {
            setLocalTextModel(null)
            setModelSettingsOpen(false)
          }}
          onClose={() => setModelSettingsOpen(false)}
        />
      )}
    </main>
  )
}

function TaskHistoryPanel({
  tasks,
  error,
  cancellingTask,
  onCancel,
  onReadOutput,
  onInsertOutput,
  onClose,
}: {
  tasks: DesktopTask[]
  error: string
  cancellingTask: string | null
  onCancel: (task: DesktopTask) => void
  onReadOutput: (taskId: string) => Promise<string>
  onInsertOutput: (text: string) => void
  onClose: () => void
}) {
  const [outputTaskId, setOutputTaskId] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, string>>({})
  const [readingTaskId, setReadingTaskId] = useState<string | null>(null)
  const [outputError, setOutputError] = useState('')

  const toggleOutput = async (taskId: string) => {
    if (outputTaskId === taskId) {
      setOutputTaskId(null)
      return
    }
    setOutputTaskId(taskId)
    setOutputError('')
    if (outputs[taskId] !== undefined) return
    setReadingTaskId(taskId)
    try {
      const text = await onReadOutput(taskId)
      setOutputs((current) => ({ ...current, [taskId]: text }))
    } catch (cause) {
      setOutputError(cause instanceof Error ? cause.message : '无法读取本地任务结果。')
    } finally {
      setReadingTaskId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="desktop-task-history-title">
        <header className="flex items-center justify-between border-b border-black/8 px-5 py-4">
          <div>
            <h2 id="desktop-task-history-title" className="text-base font-bold">本地任务记录</h2>
            <p className="mt-1 text-xs text-[#777]">任务状态保存在当前项目中。</p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">关闭</button>
        </header>
        <p className="border-b border-amber-100 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-900">
          已接入本地文本生成；图像、音频和视频生成尚未接入。任务仅发送到已配置的本机模型服务。
        </p>
        {error && <p role="alert" className="border-b border-red-100 bg-red-50 px-5 py-3 text-xs text-red-700">{error}</p>}
        {outputError && <p role="alert" className="border-b border-red-100 bg-red-50 px-5 py-3 text-xs text-red-700">{outputError}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tasks.length === 0
            ? <p className="py-12 text-center text-sm text-[#888]">此项目还没有任务记录。</p>
            : <ul className="space-y-2">{tasks.map((task) => (
              <li key={task.taskId} className="rounded-xl border border-black/8 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{taskModalityLabel(task.modality)} · {taskStatusLabel(task.status)}</p>
                    <p className="mt-1 text-xs text-[#777]">{formatTaskDate(task.updatedAt)} · 尝试 {task.attemptCount} 次</p>
                    {task.status === 'failed' && <p className="mt-2 text-xs text-red-700">{taskFailureLabel(task.errorCode)}</p>}
                    {task.status === 'interrupted' && <p className="mt-2 text-xs text-amber-800">应用关闭时任务仍在执行，系统没有自动重复提交。</p>}
                  </div>
                  {task.status === 'queued' && (
                    <button
                      onClick={() => onCancel(task)}
                      disabled={cancellingTask !== null}
                      className="shrink-0 rounded-lg border border-black/12 px-2.5 py-1.5 text-xs font-bold disabled:opacity-50"
                    >
                      {cancellingTask === task.taskId ? '正在取消…' : '取消'}
                    </button>
                  )}
                </div>
                {task.status === 'succeeded' && task.modality === 'text' && (
                  <div className="mt-3 border-t border-black/8 pt-3">
                    <button onClick={() => void toggleOutput(task.taskId)} className="rounded-lg border border-black/12 px-2.5 py-1.5 text-xs font-bold">
                      {readingTaskId === task.taskId ? '正在读取…' : outputTaskId === task.taskId ? '收起结果' : '查看文本结果'}
                    </button>
                    {outputTaskId === task.taskId && outputs[task.taskId] !== undefined && (
                      <>
                        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#f7f7f8] p-3 text-xs leading-5">{outputs[task.taskId]}</pre>
                        <button onClick={() => onInsertOutput(outputs[task.taskId])} className="mt-2 rounded-lg bg-[#171717] px-3 py-2 text-xs font-bold text-white">加入画布新文本节点</button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}</ul>}
        </div>
      </aside>
    </div>
  )
}

function taskModalityLabel(modality: DesktopTask['modality']) {
  return ({ text: '文本', image: '图像', audio: '音频', video: '视频' })[modality]
}

function taskStatusLabel(status: DesktopTask['status']) {
  return ({
    queued: '排队中',
    running: '执行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  })[status]
}

function taskFailureLabel(errorCode: string | null) {
  return ({
    CLOUD_TASK_DISABLED: '云端任务未获启用，本机不会自动转发此请求。',
    UNSUPPORTED_MODALITY: '此生成类型尚未接入本地执行器。',
    LOCAL_MODEL_CONFIGURATION_CHANGED: '模型配置已变化，请使用当前配置重新提交。',
    LOCAL_MODEL_CONFIGURATION_INVALID: '本地模型配置无效，请重新配置。',
    LOCAL_MODEL_UNAVAILABLE: '无法连接本地模型服务，请确认服务已启动。',
    LOCAL_MODEL_REQUEST_FAILED: '本地模型请求失败，请检查模型服务。',
    LOCAL_MODEL_INVALID_RESPONSE: '本地模型没有返回可用的文本结果。',
    LOCAL_MODEL_OUTPUT_INVALID: '本地模型结果无法安全保存。',
    LOCAL_MODEL_EXECUTION_FAILED: '本地文本生成失败。',
  } as Record<string, string>)[errorCode ?? ''] ?? '本地任务未完成。'
}

function formatTaskDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString()
}

function LocalTextModelSettings({
  initialConfig,
  loadError,
  onSaved,
  onCleared,
  onClose,
}: {
  initialConfig: DesktopLocalTextModel | null
  loadError: string
  onSaved: (config: DesktopLocalTextModel) => void
  onCleared: () => void
  onClose: () => void
}) {
  const [endpoint, setEndpoint] = useState(initialConfig?.endpoint ?? 'http://127.0.0.1:1234/v1')
  const [modelId, setModelId] = useState(initialConfig?.modelId ?? '')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(loadError)
  const [message, setMessage] = useState('')

  const discover = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const discovered = await bridge.discoverLocalModels(endpoint)
      setModels(discovered)
      if (discovered.length === 0) setMessage('服务可连接，但没有公布可选模型。')
      else {
        if (!discovered.includes(modelId)) setModelId(discovered[0])
        setMessage(`找到 ${discovered.length} 个文本模型。`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地模型列表。')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      onSaved(await bridge.saveLocalTextModel({ endpoint, modelId }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存本地模型配置失败。')
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    try {
      await bridge.clearLocalTextModel()
      onCleared()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除本地模型配置失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-5" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="local-model-settings-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="local-model-settings-title" className="text-lg font-bold">本地文本模型</h2>
            <p className="mt-1 text-xs leading-5 text-[#777]">只连接本机服务，不会自动切换到云端，也不需要在此输入 API Key。</p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">关闭</button>
        </div>
        <label htmlFor="local-model-endpoint" className="mt-6 block text-sm font-semibold">OpenAI 兼容服务地址</label>
        <input
          id="local-model-endpoint"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          maxLength={500}
          placeholder="http://127.0.0.1:1234/v1"
          className="mt-2 h-11 w-full rounded-xl border border-black/12 px-3 text-sm outline-none focus:border-[#8a72e8]"
        />
        <p className="mt-2 text-xs leading-5 text-[#888]">地址必须使用 localhost、127.0.0.1 或 ::1。点击“读取模型”时会向该服务的 /models 路径发起本地请求。</p>
        <button onClick={() => void discover()} disabled={busy || !endpoint.trim()} className="mt-4 rounded-lg border border-black/12 px-3 py-2 text-xs font-bold disabled:opacity-50">
          {busy ? '请稍候…' : '读取模型'}
        </button>
        <label htmlFor="local-model-id" className="mt-4 block text-sm font-semibold">模型</label>
        {models.length > 0
          ? <select id="local-model-id" value={modelId} onChange={(event) => setModelId(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-black/12 bg-white px-3 text-sm outline-none focus:border-[#8a72e8]">
            {models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          : <input
            id="local-model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            maxLength={200}
            placeholder="先读取模型，或输入服务提供的模型 ID"
            className="mt-2 h-11 w-full rounded-xl border border-black/12 px-3 text-sm outline-none focus:border-[#8a72e8]"
          />}
        {message && <p role="status" className="mt-3 text-xs text-[#666]">{message}</p>}
        {(error || loadError) && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error || loadError}</p>}
        <div className="mt-6 flex justify-end gap-2">
          {initialConfig && <button onClick={() => void clear()} disabled={busy} className="mr-auto rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50">移除配置</button>}
          <button onClick={onClose} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">取消</button>
          <button onClick={() => void save()} disabled={busy || !modelId.trim()} className="rounded-lg bg-[#171717] px-4 py-2 text-xs font-bold text-white disabled:opacity-50">保存配置</button>
        </div>
      </section>
    </div>
  )
}
