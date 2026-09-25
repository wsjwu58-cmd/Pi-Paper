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
