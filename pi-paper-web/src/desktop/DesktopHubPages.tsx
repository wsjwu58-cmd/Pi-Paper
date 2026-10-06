import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HistoryPage } from '@/features/history/HistoryPage'
import { WorkspacePage, type WorkspaceDesktopProject } from '@/features/workspace/WorkspacePage'
import type { DesktopProject, DesktopTask, DesktopTaskInputSnapshot } from './desktop-bridge'

const bridge = window.vibepaperDesktop

function canvasRoute(project: DesktopProject) {
  return `/canvas/${encodeURIComponent(project.canvasId)}`
}

export function DesktopWorkspaceLanding() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<DesktopProject[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const loadProjects = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      if (!bridge) throw new Error('桌面项目接口不可用。')
      if (bridge.listRecentProjects) {
        setProjects(await bridge.listRecentProjects())
      } else {
        const active = await bridge.getActiveProject()
        setProjects(active ? [active] : [])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地项目列表。')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadProjects() }, [loadProjects])

  const selectProject = async (candidate: WorkspaceDesktopProject) => {
    setError('')
    try {
      if (!bridge) throw new Error('桌面项目接口不可用。')
      let selected: DesktopProject | null = null
      if (bridge.openRecentProject) {
        selected = await bridge.openRecentProject(candidate.projectId)
      } else {
        const active = await bridge.getActiveProject()
        if (active?.projectId === candidate.projectId) selected = active
        else throw new Error('打开最近项目接口尚未接入，请使用“打开已有项目”选择项目文件夹。')
      }
      if (!selected) throw new Error('本地项目没有打开。')
      navigate(canvasRoute(selected))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开本地项目。')
      await loadProjects()
    }
  }

  const openExistingProject = async () => {
    setError('')
    try {
      const project = await bridge?.openProject()
      if (project) navigate(canvasRoute(project))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开本地项目。')
    }
  }

  const createProject = async (name: string) => {
    setError('')
    try {
      const project = await bridge?.createProject(name)
      if (project) navigate(canvasRoute(project))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建本地项目。')
    }
  }

  return <WorkspacePage desktopAdapter={{
    projects,
    isLoading,
    error,
    onSelectProject: selectProject,
    onOpenExistingProject: openExistingProject,
    onCreateProject: createProject,
  }} />
}

export function DesktopHistoryPage() {
  const [project, setProject] = useState<DesktopProject | null>(null)
  const [tasks, setTasks] = useState<DesktopTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      if (!bridge) throw new Error('桌面任务接口不可用。')
      const active = await bridge.getActiveProject()
      setProject(active)
      if (!active) {
        setTasks([])
        return
      }
      setTasks(await bridge.listTasks(active.projectId, 500))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地任务记录。')
      setTasks([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const getTaskInput = useCallback(async (taskId: string): Promise<DesktopTaskInputSnapshot | null> => {
    if (!bridge?.getTaskInput || !project) return null
    return bridge.getTaskInput(project.projectId, taskId)
  }, [project])

  const readTaskOutput = useCallback(async (taskId: string): Promise<string> => {
    if (!bridge || !project) throw new Error('没有已打开的本地项目。')
    return bridge.readTaskOutput(project.projectId, taskId)
  }, [project])

  return <HistoryPage desktopAdapter={{
    projectName: project?.name ?? null,
    tasks,
    isLoading,
    error,
    reload,
    getTaskInput,
    readTaskOutput,
  }} />
}
