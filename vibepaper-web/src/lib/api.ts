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

    const renderBatchListMatch = /^\/drama\/render-batches$/u.test(pathname)
    const renderBatchDetailMatch = /^\/drama\/render-batches\/([^/]+)$/u.exec(pathname)
    if (renderBatchListMatch || renderBatchDetailMatch || pathname.startsWith('/drama/render-batches/')) {
      if (method !== 'GET') {
        throw new ApiError(
          0,
          'DESKTOP_RENDER_BATCH_UNAVAILABLE',
          '桌面本地没有可验证的已接受关键帧记录，也未接入批次确认、任务提交、状态同步和重跑流程。',
        )
      }
      const project = await bridge.getActiveProject()
      if (!project) throw new ApiError(0, 'PROJECT_REQUIRED', '没有打开的本地项目。')
      const requestedCanvasId = url.searchParams.get('canvasId')
      if (requestedCanvasId && requestedCanvasId !== project.canvasId) {
        throw new ApiError(0, 'PROJECT_CHANGED', '当前本地项目与请求的画布不匹配，请重新打开画布。')
      }
      if (renderBatchDetailMatch) {
        let batchId: string
        try { batchId = decodeURIComponent(renderBatchDetailMatch[1]) } catch {
          throw new ApiError(400, 'DRAMA_BATCH_INPUT_INVALID', '渲染批次标识无效。')
        }
        return await bridge.getDramaRenderBatch(project.projectId, project.canvasId, batchId) as T
      }
      return await bridge.listDramaRenderBatches(project.projectId, project.canvasId) as T
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
