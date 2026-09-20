export interface ExecutionStep {
  id: string
  /** plan=待执行 · result=工具完成 · reasoning=推理 · speech=对用户说话 */
  kind: 'plan' | 'result' | 'reasoning' | 'speech'
  tool?: string
  label: string
  summary: string
  /** 展开工具行时展示的细节（创作者语言） */
  reasoning?: string
  ok?: boolean
  detail?: string
  rawDetail?: string
  attempt?: number
  maxAttempts?: number
}

export interface AgentSuggestion {
  type?: string
  title?: string
  content?: string
  prompt?: string
  nodeParams?: Record<string, unknown>
}

/** 高风险 Agent 动作必须通过此卡片确认；令牌绑定用户、画布版本和动作摘要。 */
export interface AgentConfirmation {
  actionId: string
  approvalToken: string
  tool?: string
  summary: string
  confirmReason?: string
  estimatedCost?: number
  chainEstimatedCost?: number
  estimatedTotalCost?: number
  approvedCostCap?: number
  affectedNodeCount?: number
  canvasVersion?: number
  planVersion?: number
  expiresAt?: string
  status?: 'pending' | 'submitting' | 'accepted' | 'rejected'
}

export interface AgentNodeReference {
  nodeId: string
  nodeType: string
  creativeType?: string
  title: string
  status: string
  previewUrl?: string
  textContent?: string
  prompt?: string
}

export interface AgentChatMsg {
  id: number | string
  role: string
  type: string
  content: string
  meta?: {
    replyType?: string
    pipelineStage?: string
    suggestions?: AgentSuggestion[]
    nextActions?: string[]
    loadedSkills?: string[]
    executionSteps?: ExecutionStep[]
    taskStatus?: { taskId?: string; status?: string; nodeId?: string; modelType?: string }
    selectedNodeIds?: string[]
    selectedSkillId?: string
    nodeReferences?: AgentNodeReference[]
    requiresConfirmation?: boolean
    confirmation?: AgentConfirmation
    errorCode?: string
    runStatus?: string
    runId?: string
  }
}

  /** 与官网 Vivi 工具行文案对齐；P0 控制平面按能力归类 */
  export const TOOL_LABELS: Record<string, string> = {
    get_canvas_summary: '读取画布概览',
    get_selected_nodes: '读取选中节点',
    get_node_detail: '读取节点详情',
    get_all_nodes: '统计画布节点',
    list_models: '查询模型',
    search_assets: '查询资源',
    create_nodes: '编辑画布',
    connect_nodes: '编辑画布',
    layout_nodes: '编辑画布',
    update_node_config: '编辑画布',
    delete_nodes: '编辑画布',
    change_model: '切换模型',
    replace_output: '覆盖输出',
    submit_generation: '提交生成',
    submit_generation_batch: '提交批量生成',
    check_task_status: '查询任务',
    update_memory: '更新记忆',
    clock: '安排跟进',
    load_skill: '加载技能',
    extract_frames: '抽帧',
    trim_clip: '裁剪片段',
    upscale: '超分',
    outpaint: '扩图',
    compose_final: '合成成片',
    capture_3d_scene: '导演台捕获',
    // P0 能力门面（若 SSE 直接透出 operation）
    read: '读取资源',
    query: '查询资源',
    create: '编辑画布',
    patch: '编辑画布',
    connect: '编辑画布',
    disconnect: '编辑画布',
    delete: '编辑画布',
    layout: '编辑画布',
    submit: '提交生成',
    extract_clip: '裁剪片段',
    extract_frame: '抽帧',
    compose: '合成成片',
    sign: '素材认证',
    retry: '重试制品',
    capture: '导演台捕获',
  }

export function toolLabel(tool?: string): string {
  if (!tool) return '操作'
  return TOOL_LABELS[tool] || tool
}

export function stepFromPlan(
  tool: string | undefined,
  summary: string,
  idx: number,
  reasoning?: string,
): ExecutionStep {
  return {
    id: `plan-${idx}-${tool ?? 'x'}`,
    kind: 'plan',
    tool,
    label: toolLabel(tool),
    summary,
    reasoning: reasoning?.trim() || undefined,
  }
}

export function stepFromThinking(content: string, idx: number): ExecutionStep {
  return {
    id: `reason-${idx}`,
    kind: 'reasoning',
    label: '推理过程',
    summary: content.trim(),
  }
}

export function stepFromSpeech(content: string, idx: number): ExecutionStep {
  return {
    id: `speech-${idx}`,
    kind: 'speech',
    label: '回复',
    summary: content.trim(),
  }
}

export function stepFromResult(
  tool: string | undefined,
  ok: boolean,
  summary: string,
  detail?: string,
  idx = 0,
): ExecutionStep {
  return {
    id: `result-${idx}-${tool ?? 'x'}`,
    kind: 'result',
    tool,
    label: toolLabel(tool),
    summary,
    ok,
    detail,
  }
}
