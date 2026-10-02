import type { TokenResponse } from "./types";
import { parseJsonPreserveIds } from "./ids";

/** Prefer same-origin `/api/v1` (Vite proxy) to avoid CORS; override with VITE_API_BASE if needed. */
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api/v1";

let accessToken: string | null = localStorage.getItem("vp_access");
let refreshToken: string | null = localStorage.getItem("vp_refresh");
let refreshInFlight: Promise<boolean> | null = null;

export function setTokens(t: TokenResponse | null) {
  if (t) {
    accessToken = t.accessToken;
    refreshToken = t.refreshToken;
    localStorage.setItem("vp_access", t.accessToken);
    localStorage.setItem("vp_refresh", t.refreshToken);
  } else {
    accessToken = null;
    refreshToken = null;
    localStorage.removeItem("vp_access");
    localStorage.removeItem("vp_refresh");
  }
}

export function getAccessToken() {
  return accessToken ?? localStorage.getItem("vp_access");
}

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  status: number;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

async function refreshAccess(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = parseJsonPreserveIds<TokenResponse>(await res.text());
      setTokens(data);
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function resolveApiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith(API_BASE)) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

const STANDARD_VERTICAL_SHORT_DRAMA_FORMAT = {
  id: 'vertical-short-drama-v1',
  aspectRatio: '9:16' as const,
  targetDurationSeconds: 180,
  minShotCount: 60,
  maxShotCount: 90,
  minShotDurationSeconds: 2,
  maxShotDurationSeconds: 5,
  keyframeFirst: true as const,
}

function parseLocalJsonObject(options: RequestInit, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(typeof options.body === 'string' ? options.body : '')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', `${label}请求无效。`)
  }
}

function localDramaPathId(segment: string, label: string): string {
  try {
    const id = decodeURIComponent(segment).trim()
    if (!id) throw new Error('empty')
    return id
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', `${label}标识无效。`)
  }
}

function localDramaRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'INVALID_INPUT', `缺少或非法 ${field}`)
  return value.trim()
}

function localDramaOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function localDramaInteger(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'INVALID_INPUT', `缺少或非法 ${field}`)
  }
  return value
}

function localDramaOptionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function localDramaStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new ApiError(400, 'INVALID_INPUT', '字段必须是非空字符串数组')
  }
  return value.map((item: string) => item.trim())
}

function localDramaStatus<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiError(400, 'INVALID_INPUT', 'status 无效')
  }
  return value as T
}

function localMemoryScope(value: unknown, optional = false): 'session' | 'canvas' | 'project' | 'global' | 'daily' | undefined {
  if (optional && value === undefined) return undefined
  if (value === 'long_term' || value === 'project') return 'project'
  if (value === 'session' || value === 'canvas' || value === 'global' || value === 'daily') return value
  throw new ApiError(400, 'AGENT_MEMORY_SCOPE_INVALID', '记忆范围无效。')
}

function localMemoryContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) {
    throw new ApiError(400, 'AGENT_MEMORY_INPUT_INVALID', '记忆内容不能为空且不得超过 2000 个字符。')
  }
  return value.trim()
}

/** Authenticated fetch that retries once after refresh on 401. Use for SSE / non-JSON bodies. */
export async function authedFetch(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<Response> {
  if (typeof window !== "undefined" && (window.vibepaperDesktop || window.location.protocol === "vibe:")) {
    throw new ApiError(0, "DESKTOP_API_UNAVAILABLE", "此功能尚未接入本地项目，请使用桌面画布中的本地操作入口。");
  }
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const applyAuth = () => {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else delete headers.Authorization;
  };

  applyAuth();
  const doFetch = () => fetch(resolveApiUrl(path), { ...options, headers });

  let res = await doFetch();
  if (res.status === 401) {
    const ok = await refreshAccess();
    if (ok) {
      applyAuth();
      res = await doFetch();
    }
  }
  return res;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase()) && !headers['Idempotency-Key']) {
    headers['Idempotency-Key'] = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  }

  if (typeof window !== "undefined" && (window.vibepaperDesktop || window.location.protocol === "vibe:")) {
    const bridge = window.vibepaperDesktop;
    if (!bridge) throw new ApiError(0, "DESKTOP_BRIDGE_UNAVAILABLE", "桌面本地桥接不可用，请重新启动桌面应用。")
    const url = new URL(path, "http://desktop.local");
    if (url.origin !== "http://desktop.local") {
      throw new ApiError(0, "DESKTOP_API_UNAVAILABLE", "桌面本地项目不支持此服务请求。")
    }
    const pathname = url.pathname.replace(/^\/api\/v1(?=\/)/u, "")
    const method = (options.method ?? "GET").toUpperCase()
    const sessionMatch = /^\/agent\/sessions(?:\/([^/]+)(?:\/(copy|skills|plans)(?:\/([^/]+):attach)?)?)?$/u.exec(pathname)
    const planMatch = /^\/agent\/plans\/([^/]+)(?:\/(ready-set|rerun))?$/u.exec(pathname)
    if (sessionMatch || planMatch) {
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      const identifier = (raw: string): string => {
        let value: string
        try { value = decodeURIComponent(raw) } catch { throw new ApiError(400, 'INVALID_INPUT', '标识无效。') }
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new ApiError(400, 'INVALID_INPUT', '标识无效。')
        return value
      }
      if (planMatch) {
        const planId = identifier(planMatch[1])
        if (!planMatch[2] && method === 'GET') return await bridge.getAgentPlan(project.projectId, planId) as T
        if (planMatch[2] === 'ready-set' && method === 'GET') {
          return await bridge.getAgentPlanReadySet(project.projectId, planId, url.searchParams.get('profile') ?? undefined) as T
        }
        if (planMatch[2] === 'rerun' && method === 'POST') {
          const body = parseLocalJsonObject(options, '计划续跑')
          if (typeof body.stepId !== 'string') throw new ApiError(400, 'INVALID_INPUT', '请选择计划步骤。')
          return await bridge.rerunAgentPlan(project.projectId, planId, identifier(body.stepId)) as T
        }
      } else if (sessionMatch) {
        if (!sessionMatch[1]) {
          if (method === 'GET') {
            const status = url.searchParams.get('status') ?? 'all'
            if (!['active', 'archived', 'all'].includes(status)) throw new ApiError(400, 'INVALID_INPUT', '会话状态无效。')
            return await bridge.listAgentSessions(project.projectId, { status: status as 'active' | 'archived' | 'all' }) as T
          }
          if (method === 'POST') {
            const body = parseLocalJsonObject(options, '会话创建')
            if (body.canvasId !== undefined && body.canvasId !== project.canvasId) throw new ApiError(409, 'PROJECT_CHANGED', '画布不匹配。')
            return await bridge.createAgentSession(project.projectId, typeof body.title === 'string' ? body.title : undefined) as T
          }
        } else {
          const sessionId = identifier(sessionMatch[1])
          const action = sessionMatch[2]
          if (!action && method === 'GET') return await bridge.getAgentSession(project.projectId, sessionId) as T
          if (!action && method === 'DELETE') return await bridge.deleteAgentSession(project.projectId, sessionId) as T
          if (!action && method === 'PATCH') return await bridge.updateAgentSession(project.projectId, sessionId, parseLocalJsonObject(options, '会话更新')) as T
          if (action === 'copy' && method === 'POST') return await bridge.copyAgentSession(project.projectId, sessionId, parseLocalJsonObject(options, '会话复制')) as T
          if (action === 'plans' && method === 'POST') return await bridge.createAgentPlan(project.projectId, sessionId, parseLocalJsonObject(options, '计划创建')) as T
          if (action === 'skills' && !sessionMatch[3] && method === 'PUT') {
            const body = parseLocalJsonObject(options, '会话技能设置')
            if (!Array.isArray(body.skillIds) || body.skillIds.some((id) => typeof id !== 'string')) throw new ApiError(400, 'INVALID_INPUT', '技能列表无效。')
            return await bridge.setAgentSessionSkills(project.projectId, sessionId, body.skillIds as string[]) as T
          }
          if (action === 'skills' && sessionMatch[3] && method === 'POST') return await bridge.attachAgentSessionSkill(project.projectId, sessionId, identifier(sessionMatch[3])) as T
        }
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Agent 接口不支持此请求方法。')
    }
    const fragmentListPath = pathname === '/agent/fragments'
    const fragmentSaveMatch = /^\/agent\/sessions\/([^/]+)\/fragments$/u.exec(pathname)
    const fragmentImportMatch = /^\/agent\/fragments\/([^/]+)\/import$/u.exec(pathname)
    if (fragmentListPath || fragmentSaveMatch || fragmentImportMatch) {
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      if (fragmentListPath) {
        if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '会话片段只支持读取。')
        return await bridge.listAgentFragments(project.projectId) as T
      }
      if (fragmentSaveMatch) {
        if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '保存会话片段只支持提交。')
        let sessionId: string
        try { sessionId = decodeURIComponent(fragmentSaveMatch[1]) } catch {
          throw new ApiError(400, 'AGENT_SESSION_INPUT_INVALID', 'Agent 会话标识无效。')
        }
        if (!sessionId || sessionId.length > 128) {
          throw new ApiError(400, 'AGENT_SESSION_INPUT_INVALID', 'Agent 会话标识无效。')
        }
        const body = parseLocalJsonObject(options, '会话片段保存')
        const title = body.title
        if (title !== undefined && (typeof title !== 'string' || title.length > 120)) {
          throw new ApiError(400, 'AGENT_SESSION_FRAGMENT_INPUT_INVALID', '会话片段标题无效。')
        }
        return await bridge.saveAgentSessionFragment(project.projectId, sessionId, title) as T
      }
      if (!fragmentImportMatch) throw new ApiError(400, 'AGENT_SESSION_FRAGMENT_INPUT_INVALID', '会话片段标识无效。')
      if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '导入会话片段只支持提交。')
      let fragmentId: string
      try { fragmentId = decodeURIComponent(fragmentImportMatch[1]) } catch {
        throw new ApiError(400, 'AGENT_SESSION_FRAGMENT_INPUT_INVALID', '会话片段标识无效。')
      }
      if (!fragmentId || fragmentId.length > 128) {
        throw new ApiError(400, 'AGENT_SESSION_FRAGMENT_INPUT_INVALID', '会话片段标识无效。')
      }
      const body = parseLocalJsonObject(options, '会话片段导入')
      const canvasId = body.canvasId
      if (canvasId !== undefined && (typeof canvasId !== 'string' || canvasId !== project.canvasId)) {
        throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
      }
      return await bridge.importAgentFragment(project.projectId, fragmentId, canvasId) as T
    }
    const memoryListPath = pathname === '/memories'
    const memoryExportPath = pathname === '/memories/export'
    const memoryItemMatch = /^\/memories\/([^/]+)$/u.exec(pathname)
    const memoryCandidatesPath = pathname === '/memory-candidates'
    const memoryCandidateMatch = /^\/memory-candidates\/([^/]+)\/(accept|reject)$/u.exec(pathname)
    if (memoryListPath || memoryExportPath || memoryItemMatch || memoryCandidatesPath || memoryCandidateMatch) {
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      if (memoryExportPath) {
        if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '记忆导出只支持读取。')
        return await bridge.exportAgentMemories(project.projectId) as T
      }
      if (memoryListPath) {
        if (method === 'GET') {
          const scope = localMemoryScope(url.searchParams.get('scope') ?? undefined, true)
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          if (sessionId !== undefined && (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId))) {
            throw new ApiError(400, 'AGENT_SESSION_INPUT_INVALID', 'Agent 会话标识无效。')
          }
          if (scope === 'session' && !sessionId) {
            throw new ApiError(400, 'AGENT_MEMORY_SESSION_REQUIRED', '请选择一个 Agent 会话。')
          }
          return await bridge.listAgentMemories(project.projectId, scope, sessionId) as T
        }
        if (method === 'POST') {
          const body = parseLocalJsonObject(options, '记忆创建')
          const scope = localMemoryScope(body.scope, true) ?? 'project'
          const sessionId = body.sessionId
          if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId))) {
            throw new ApiError(400, 'AGENT_SESSION_INPUT_INVALID', 'Agent 会话标识无效。')
          }
          if (scope === 'session' && typeof sessionId !== 'string') {
            throw new ApiError(400, 'AGENT_MEMORY_SESSION_REQUIRED', '请选择一个 Agent 会话。')
          }
          const saved = await bridge.createAgentMemory(project.projectId, localMemoryContent(body.content), scope, sessionId)
          return { id: saved.id, content: saved.content, scope: saved.scope } as T
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '记忆接口不支持此请求方法。')
      }
      if (memoryCandidatesPath) {
        if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '记忆候选列表只支持读取。')
        return await bridge.listAgentMemoryCandidates(project.projectId) as T
      }
      if (memoryItemMatch) {
        let memoryId: string
        try { memoryId = decodeURIComponent(memoryItemMatch[1]) } catch {
          throw new ApiError(400, 'AGENT_MEMORY_INPUT_INVALID', '记忆标识无效。')
        }
        if (method === 'DELETE') {
          const scope = localMemoryScope(url.searchParams.get('scope') ?? undefined, true)
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          if (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
            throw new ApiError(400, 'AGENT_SESSION_INPUT_INVALID', 'Agent 会话标识无效。')
          }
          if (scope === 'session' && !sessionId) throw new ApiError(400, 'AGENT_MEMORY_SESSION_REQUIRED', '请选择一个 Agent 会话。')
          return await bridge.deleteAgentMemory(project.projectId, memoryId, scope, sessionId) as T
        }
        if (method === 'PATCH' || method === 'PUT') {
          const body = parseLocalJsonObject(options, '记忆更新')
          const scope = localMemoryScope(body.scope, true)
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          if (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
            throw new ApiError(400, 'AGENT_SESSION_INPUT_INVALID', 'Agent 会话标识无效。')
          }
          if (scope === 'session' && !sessionId) throw new ApiError(400, 'AGENT_MEMORY_SESSION_REQUIRED', '请选择一个 Agent 会话。')
          return await bridge.updateAgentMemory(project.projectId, memoryId, localMemoryContent(body.content), scope, sessionId) as T
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '记忆条目只支持读取、修改或删除。')
      }
      if (memoryCandidateMatch) {
        let candidateId: string
        try { candidateId = decodeURIComponent(memoryCandidateMatch[1]) } catch {
          throw new ApiError(400, 'AGENT_MEMORY_INPUT_INVALID', '记忆候选标识无效。')
        }
        if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '记忆候选审阅只支持提交。')
        const action = memoryCandidateMatch[2] as 'accept' | 'reject'
        const result = await bridge.reviewAgentMemoryCandidate(project.projectId, candidateId, action)
        if (action === 'accept') {
          if (!result.item) throw new ApiError(500, 'AGENT_MEMORY_CANDIDATE_INVALID', '保存记忆候选失败。')
          return { id: result.item.id, content: result.item.content, scope: result.item.scope } as T
        }
        return { status: 'ok' } as T
      }
    }
    const dramaMatch = /^\/canvases\/([^/]+)\/drama-assets$/u.exec(pathname)
    if (dramaMatch) {
      let canvasId: string
      try { canvasId = decodeURIComponent(dramaMatch[1]) } catch {
        throw new ApiError(400, "CANVAS_ID_INVALID", "画布标识无效。")
      }
      const project = await bridge.getActiveProject()
      if (!project || project.canvasId !== canvasId) {
        throw new ApiError(0, "PROJECT_CHANGED", "当前本地项目与请求的画布不匹配，请重新打开画布。")
      }
      if (method === "GET") {
        const filters = Object.fromEntries(
          ["assetType", "episodeId", "sceneId", "shotId"]
            .map((key) => [key, url.searchParams.get(key)])
            .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
        )
        return await bridge.listDramaAssets(project.projectId, canvasId, filters) as T
      }
      if (method === "POST") {
        let body: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(typeof options.body === "string" ? options.body : "")
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid")
          body = parsed as Record<string, unknown>
        } catch {
          throw new ApiError(400, "DRAMA_ASSET_INPUT_INVALID", "短剧资产写入请求无效。")
        }
        const idempotencyKey = options.idempotencyKey ?? headers["Idempotency-Key"]
        return await bridge.upsertDramaAsset({
          ...body,
          projectId: project.projectId,
          canvasId,
          idempotencyKey,
        } as Parameters<typeof bridge.upsertDramaAsset>[0]) as T
      }
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "短剧资产接口不支持此请求方法。")
    }

    const dramaSeriesCreateMatch = pathname === '/drama/series'
    const dramaCharacterCreateMatch = /^\/drama\/series\/([^/]+)\/characters$/u.exec(pathname)
    const dramaReferencePackCreateMatch = /^\/drama\/characters\/([^/]+)\/reference-packs$/u.exec(pathname)
    const dramaShotCreateMatch = /^\/drama\/series\/([^/]+)\/shots$/u.exec(pathname)
    const dramaKeyframeNodeMatch = /^\/drama\/shots\/([^/]+)\/keyframe-node$/u.exec(pathname)
    const dramaKeyframeRecordMatch = /^\/drama\/shots\/([^/]+)\/keyframes$/u.exec(pathname)
    const dramaVideoNodeMatch = /^\/drama\/shots\/([^/]+)\/video-node$/u.exec(pathname)
    const dramaLineageCreateMatch = pathname === '/drama/lineages'
    const dramaStaleLineagesMatch = /^\/drama\/characters\/([^/]+)\/stale-lineages$/u.exec(pathname)
    if (dramaSeriesCreateMatch || dramaCharacterCreateMatch || dramaReferencePackCreateMatch
      || dramaShotCreateMatch || dramaKeyframeNodeMatch || dramaKeyframeRecordMatch
      || dramaVideoNodeMatch || dramaLineageCreateMatch || dramaStaleLineagesMatch) {
      if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '短剧状态接口不支持此请求方法。')
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      const idempotencyKey = options.idempotencyKey ?? headers['Idempotency-Key']
      if (!idempotencyKey) throw new ApiError(400, 'INVALID_INPUT', 'Idempotency-Key 无效。')
      const scope = { projectId: project.projectId, canvasId: project.canvasId, idempotencyKey }

      if (dramaSeriesCreateMatch) {
        const body = parseLocalJsonObject(options, '短剧系列创建')
        if (body.canvasId !== project.canvasId) {
          throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
        }
        return await bridge.createDramaSeries({
          ...scope,
          series: {
            ...(localDramaOptionalText(body.id) ? { id: localDramaOptionalText(body.id) } : {}),
            activeCanonRevision: typeof body.activeCanonRevision === 'number'
              && Number.isSafeInteger(body.activeCanonRevision) && body.activeCanonRevision >= 0
              ? body.activeCanonRevision : 1,
            format: STANDARD_VERTICAL_SHORT_DRAMA_FORMAT,
          },
        }) as T
      }

      if (dramaCharacterCreateMatch) {
        const body = parseLocalJsonObject(options, '角色创建')
        return await bridge.createDramaCharacter({
          ...scope,
          character: {
            ...(localDramaOptionalText(body.id) ? { id: localDramaOptionalText(body.id) } : {}),
            seriesId: localDramaPathId(dramaCharacterCreateMatch[1], '短剧系列'),
            name: localDramaRequiredText(body.name, 'name'),
            identityAnchors: localDramaStringArray(body.identityAnchors),
            activeLookRevision: localDramaOptionalInteger(body.activeLookRevision) ?? 1,
            voiceId: localDramaRequiredText(body.voiceId, 'voiceId'),
          },
        }) as T
      }

      if (dramaReferencePackCreateMatch) {
        const body = parseLocalJsonObject(options, '角色参考包创建')
        return await bridge.addDramaReferencePack({
          ...scope,
          pack: {
            ...(localDramaOptionalText(body.id) ? { id: localDramaOptionalText(body.id) } : {}),
            characterId: localDramaPathId(dramaReferencePackCreateMatch[1], '角色'),
            lookRevision: localDramaInteger(body.lookRevision, 'lookRevision'),
            status: localDramaStatus(body.status, ['draft', 'approved', 'retired'] as const),
            frontAssetId: localDramaRequiredText(body.frontAssetId, 'frontAssetId'),
            sideAssetId: localDramaRequiredText(body.sideAssetId, 'sideAssetId'),
            backAssetId: localDramaRequiredText(body.backAssetId, 'backAssetId'),
            expressionAssetIds: localDramaStringArray(body.expressionAssetIds),
          },
        }) as T
      }

      if (dramaShotCreateMatch) {
        const body = parseLocalJsonObject(options, '镜头创建')
        if (!Array.isArray(body.characterBindings)) {
          throw new ApiError(400, 'INVALID_INPUT', 'characterBindings 必须是数组')
        }
        const characterBindings = body.characterBindings.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new ApiError(400, 'INVALID_INPUT', 'characterBindings 格式无效')
          }
          const binding = value as Record<string, unknown>
          return {
            characterId: localDramaRequiredText(binding.characterId, 'characterId'),
            lookRevision: localDramaInteger(binding.lookRevision, 'lookRevision'),
          }
        })
        return await bridge.createDramaShot({
          ...scope,
          shot: {
            ...(localDramaOptionalText(body.id) ? { id: localDramaOptionalText(body.id) } : {}),
            seriesId: localDramaPathId(dramaShotCreateMatch[1], '短剧系列'),
            episodeNo: localDramaInteger(body.episodeNo, 'episodeNo'),
            shotNo: localDramaInteger(body.shotNo, 'shotNo'),
            durationSeconds: localDramaInteger(body.durationSeconds, 'durationSeconds'),
            characterBindings,
            promptRevision: localDramaOptionalInteger(body.promptRevision) ?? 1,
          },
        }) as T
      }

      if (dramaKeyframeNodeMatch || dramaVideoNodeMatch) {
        const body = parseLocalJsonObject(options, '画布节点创建')
        if (body.canvasId !== project.canvasId) {
          throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
        }
        const shotId = localDramaPathId((dramaKeyframeNodeMatch ?? dramaVideoNodeMatch)![1], '镜头')
        const prompt = localDramaRequiredText(body.prompt, 'prompt')
        const model = localDramaOptionalText(body.model)
        if (dramaKeyframeNodeMatch) {
          const draft = await bridge.prepareDramaKeyframeNode({ projectId: project.projectId, canvasId: project.canvasId, shotId })
          const canvas = await bridge.loadCanvas(project.projectId, project.canvasId)
          const node = await bridge.createNode({
            projectId: project.projectId,
            canvasId: project.canvasId,
            expectedVersion: canvas.version,
            idempotencyKey,
            type: 'image',
            x: 220,
            y: 180,
            creativeType: 'keyframe',
            prompt,
            ...(model ? { modelRef: model } : {}),
            params: {
              shotId: draft.shotId,
              referencePackIds: draft.referencePackIds,
              referenceAssetIds: draft.referenceAssetIds,
              aspectRatio: '9:16',
              ...(model ? { model } : {}),
            },
          })
          return { ...draft, canvasNodeId: node.node.id } as T
        }
        const draft = await bridge.prepareDramaVideoNode({ projectId: project.projectId, canvasId: project.canvasId, shotId })
        const canvas = await bridge.loadCanvas(project.projectId, project.canvasId)
        const node = await bridge.createNode({
          projectId: project.projectId,
          canvasId: project.canvasId,
          expectedVersion: canvas.version,
          idempotencyKey,
          type: 'video',
          x: 220,
          y: 180,
          creativeType: 'clip',
          prompt,
          ...(model ? { modelRef: model } : {}),
          params: {
            shotId: draft.shotId,
            keyframeRenderId: draft.keyframeRenderId,
            referencePackIds: draft.referencePackIds,
            aspectRatio: '9:16',
            ...(model ? { model } : {}),
          },
        })
        return { ...draft, canvasNodeId: node.node.id } as T
      }

      if (dramaKeyframeRecordMatch) {
        const body = parseLocalJsonObject(options, '关键帧状态写入')
        return await bridge.recordDramaKeyframe({
          ...scope,
          render: {
            ...(localDramaOptionalText(body.id) ? { id: localDramaOptionalText(body.id) } : {}),
            shotId: localDramaPathId(dramaKeyframeRecordMatch[1], '镜头'),
            status: localDramaStatus(body.status, ['draft', 'accepted', 'rejected', 'stale'] as const),
            referencePackIds: localDramaStringArray(body.referencePackIds),
          },
        }) as T
      }

      if (dramaLineageCreateMatch) {
        const body = parseLocalJsonObject(options, '镜头渲染血缘写入')
        return await bridge.recordDramaLineage({
          ...scope,
          lineage: {
            ...(localDramaOptionalText(body.id) ? { id: localDramaOptionalText(body.id) } : {}),
            shotId: localDramaRequiredText(body.shotId, 'shotId'),
            keyframeRenderId: localDramaRequiredText(body.keyframeRenderId, 'keyframeRenderId'),
            status: localDramaStatus(body.status, ['draft', 'ready_for_video', 'submitted', 'stale'] as const),
          },
        }) as T
      }

      if (dramaStaleLineagesMatch) {
        const lineageIds = await bridge.staleDramaLineagesForCharacter({
          ...scope,
          characterId: localDramaPathId(dramaStaleLineagesMatch[1], '角色'),
        })
        return { lineageIds } as T
      }
    }

    if (pathname === '/drama/render-batches/candidates') {
      if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '渲染候选只支持读取。')
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      const requestedCanvasId = url.searchParams.get('canvasId')
      if (requestedCanvasId && requestedCanvasId !== project.canvasId) {
        throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
      }
      return await bridge.listDramaRenderCandidates(project.projectId, project.canvasId) as T
    }

    const renderBatchListMatch = pathname === '/drama/render-batches'
    const renderBatchDetailMatch = /^\/drama\/render-batches\/([^/]+)$/u.exec(pathname)
    const renderBatchActionMatch = /^\/drama\/render-batches\/([^/]+)\/(prepare|submit|reject)$/u.exec(pathname)
    const renderBatchRerunMatch = /^\/drama\/render-batches\/([^/]+)\/jobs\/([^/]+)\/rerun$/u.exec(pathname)
    if (renderBatchListMatch || renderBatchDetailMatch || renderBatchActionMatch || renderBatchRerunMatch) {
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      const requestedCanvasId = url.searchParams.get('canvasId')
      if (requestedCanvasId && requestedCanvasId !== project.canvasId) {
        throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
      }
      const scope = { projectId: project.projectId, canvasId: project.canvasId }
      if (method === 'GET') {
        if (renderBatchDetailMatch) {
          const batchId = localDramaPathId(renderBatchDetailMatch[1], '渲染批次')
          return await bridge.getDramaRenderBatch(project.projectId, project.canvasId, batchId) as T
        }
        if (renderBatchListMatch) return await bridge.listDramaRenderBatches(project.projectId, project.canvasId) as T
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '该渲染批次接口不支持读取。')
      }

      if (renderBatchListMatch && method === 'POST') {
        const body = parseLocalJsonObject(options, '渲染批次创建')
        if (body.canvasId !== undefined && String(body.canvasId) !== project.canvasId) {
          throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
        }
        const idempotencyKey = options.idempotencyKey ?? headers['Idempotency-Key']
        if (!idempotencyKey) throw new ApiError(400, 'INVALID_INPUT', 'Idempotency-Key 无效。')
        if (!Array.isArray(body.jobs) || body.jobs.length < 1 || body.jobs.length > 90) {
          throw new ApiError(400, 'INVALID_INPUT', '渲染批次需包含 1-90 个镜头。')
        }
        const jobs = body.jobs.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new ApiError(400, 'INVALID_INPUT', '渲染批次镜头参数无效。')
          }
          const job = value as Record<string, unknown>
          if (!job.modelParams || typeof job.modelParams !== 'object' || Array.isArray(job.modelParams)) {
            throw new ApiError(400, 'INVALID_INPUT', '渲染批次模型参数无效。')
          }
          return {
            shotId: localDramaRequiredText(job.shotId, 'shotId'),
            keyframeRenderId: localDramaRequiredText(job.keyframeRenderId, 'keyframeRenderId'),
            canvasNodeId: localDramaRequiredText(job.canvasNodeId, 'canvasNodeId'),
            durationSeconds: localDramaInteger(job.durationSeconds, 'durationSeconds'),
            modelType: 'video' as const,
            providerType: localDramaStatus(job.providerType, ['local', 'cloud'] as const),
            providerId: localDramaRequiredText(job.providerId, 'providerId'),
            modelId: localDramaRequiredText(job.modelId, 'modelId'),
            modelParams: job.modelParams as Record<string, unknown>,
          }
        })
        const canvas = await bridge.loadCanvas(project.projectId, project.canvasId)
        if (body.canvasVersion !== undefined && body.canvasVersion !== canvas.version) {
          throw new ApiError(409, 'VERSION_CONFLICT', '画布已变化，请刷新生产链候选后再创建批次。')
        }
        const batch = await bridge.createDramaRenderBatch({
          ...scope,
          idempotencyKey,
          seriesId: localDramaRequiredText(body.seriesId, 'seriesId'),
          episodeNo: localDramaInteger(body.episodeNo, 'episodeNo'),
          canvasVersion: canvas.version,
          jobs,
        })
        return await bridge.prepareDramaRenderBatchConfirmation({ ...scope, batchId: batch.id }) as T
      }

      if (renderBatchActionMatch) {
        const batchId = localDramaPathId(renderBatchActionMatch[1], '渲染批次')
        const action = renderBatchActionMatch[2]
        const body = parseLocalJsonObject(options, '渲染确认')
        if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '渲染确认接口只支持提交。')
        if (action === 'prepare') {
          const operation = body.operation === undefined ? 'submit'
            : localDramaStatus(body.operation, ['submit', 'rerun'] as const)
          const jobId = operation === 'rerun' ? localDramaRequiredText(body.jobId, 'jobId') : undefined
          return await bridge.prepareDramaRenderBatchConfirmation({ ...scope, batchId, operation, jobId }) as T
        }
        if (action === 'submit') {
          const actionId = localDramaRequiredText(body.actionId, 'actionId')
          const token = localDramaRequiredText(body.token, 'token')
          const canvasVersion = localDramaInteger(body.canvasVersion, 'canvasVersion')
          const result = await bridge.submitDramaRenderBatch({ ...scope, batchId, actionId, token, canvasVersion })
          for (const job of result.jobs ?? []) {
            if (job.canvasNodeId) window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { nodeId: job.canvasNodeId, taskId: job.taskId } }))
          }
          return result as T
        }
        const actionId = localDramaRequiredText(body.actionId, 'actionId')
        const token = localDramaRequiredText(body.token, 'token')
        return await bridge.rejectDramaRenderBatchConfirmation({ ...scope, batchId, actionId, token }) as T
      }

      if (renderBatchRerunMatch) {
        if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '局部重跑只支持提交。')
        return await bridge.rerunDramaRenderBatchJob({
          ...scope,
          batchId: localDramaPathId(renderBatchRerunMatch[1], '渲染批次'),
          jobId: localDramaPathId(renderBatchRerunMatch[2], '渲染任务'),
        }) as T
      }
    }

    if (pathname === '/render-reviews') {
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      if (method === 'GET') {
        const requestedCanvasId = url.searchParams.get('canvasId')
        if (!requestedCanvasId || requestedCanvasId !== project.canvasId) {
          throw new ApiError(400, 'CANVAS_ID_INVALID', '审校查询必须指定当前本地画布。')
        }
        const targetNodeId = url.searchParams.get('targetNodeId') ?? undefined
        return await bridge.listRenderReviews(project.projectId, project.canvasId, targetNodeId) as T
      }
      if (method === 'POST') {
        let body: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(typeof options.body === 'string' ? options.body : '')
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
          body = parsed as Record<string, unknown>
        } catch {
          throw new ApiError(400, 'RENDER_REVIEW_INPUT_INVALID', '审校写入请求无效。')
        }
        if (String(body.canvasId ?? '') !== project.canvasId) {
          throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
        }
        return await bridge.createRenderReview({
          ...body,
          projectId: project.projectId,
          canvasId: project.canvasId,
        } as Parameters<typeof bridge.createRenderReview>[0]) as T
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', '审校接口不支持此请求方法。')
    }

    const usageMatch = /^\/agent\/sessions\/([^/]+)\/usage$/u.exec(pathname)
    if (usageMatch && method === "GET") {
      let sessionId: string
      try { sessionId = decodeURIComponent(usageMatch[1]) } catch {
        throw new ApiError(400, "AGENT_SESSION_INPUT_INVALID", "Agent 会话标识无效。")
      }
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, "PROJECT_REQUIRED", "没有打开的本地项目。")
      return await bridge.getAgentUsage(project.projectId, sessionId) as T
    }

    throw new ApiError(0, "DESKTOP_API_UNAVAILABLE", "此功能尚未接入本地项目，请使用桌面画布中的本地操作入口。")
  }

  const res = await authedFetch(path, { ...options, headers });

  if (!res.ok) {
    let code = "INTERNAL_ERROR";
    let message = `请求失败 (${res.status})`;
    let details: unknown;
    let retryable = false;
    try {
      const body = parseJsonPreserveIds<{
        code?: string;
        message?: string;
        detail?: unknown;
        details?: unknown;
        retryable?: boolean;
      }>(await res.text());
      if (body.code) {
        code = body.code;
        message = body.message ?? message;
        details = body.details;
        retryable = Boolean(body.retryable);
      } else if (body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)) {
        const d = body.detail as { code?: string; message?: string; details?: unknown; retryable?: boolean };
        code = d.code || code;
        message = d.message || message;
        details = d.details ?? body.detail;
        retryable = Boolean(d.retryable);
      } else if (typeof body.detail === "string") {
        message = body.detail;
        details = body.detail;
      } else if (Array.isArray(body.detail)) {
        message = body.detail
          .map((item) => (typeof item === "object" && item && "msg" in item ? String((item as { msg: unknown }).msg) : String(item)))
          .join("; ");
        details = body.detail;
      } else if (body.message) {
        message = body.message;
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code, message, details, retryable);
  }
  if (res.status === 204) return undefined as T;
  return parseJsonPreserveIds<T>(await res.text());
}

export function assetUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (typeof window !== "undefined" && window.vibepaperDesktop) {
    return /^vibe:\/\/app\/(?:assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/output)$/iu.test(url)
      ? url
      : undefined;
  }
  if (url.startsWith("http")) return url;
  // Relative URLs go through the Vite proxy in dev
  return url.startsWith("/") ? url : `/${url}`;
}

export function apiUrl(path: string): string {
  return resolveApiUrl(path);
}

export async function uploadAsset(
  file: File,
  type?: string,
  canvasId?: string | number,
  nodeId?: string | number,
) {
  const fd = new FormData();
  fd.append("file", file);
  if (type) fd.append("type", type);
  if (canvasId != null) fd.append("canvasId", String(canvasId));
  if (nodeId != null) fd.append("nodeId", String(nodeId));
  const res = await authedFetch("/assets", {
    method: "POST",
    body: fd,
    idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  });
  if (!res.ok) throw new ApiError(res.status, "UPLOAD_FAILED", "上传失败");
  return parseJsonPreserveIds(await res.text());
}
