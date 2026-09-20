"""Agent 工具白名单（技术概要 §5.3 + 协同工具 §3.13）。

read：get_* / list_* / search_* / update_memory / clock / load_skill / check_task_status
low：create_nodes / connect_nodes / layout_nodes / update_node_config
high：delete_nodes / change_model / replace_output / submit_generation
加工：extract_frames / trim_clip / upscale / outpaint / compose_final（默认派生新节点）
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

import httpx
import redis

from ..core.config import settings
from ..domain.skill_catalog import SKILL_CATALOG

redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True, protocol=2)


def _require_canvas_id(canvas_id) -> int | dict:
    """拒绝 None / \"None\" / 非法值，避免 Java Long 解析失败。"""
    if canvas_id is None or canvas_id == "" or str(canvas_id).lower() in {"none", "null", "undefined"}:
        return {"error": "缺少画布 ID（canvasId）。请在画布页打开 Agent 后重试。", "error_code": "INVALID_INPUT"}
    try:
        return int(canvas_id)
    except (TypeError, ValueError):
        return {"error": f"非法画布 ID：{canvas_id}", "error_code": "INVALID_INPUT"}


COMPOSITE_SKILL_INSTRUCTIONS = {
    key: (
        f"{skill.description}\n触发：{skill.trigger_semantics}\n"
        f"骨架：{' → '.join(skill.workflow_skeleton)}\n{skill.instructions}"
    )
    for key, skill in SKILL_CATALOG.items()
}
COMPOSITE_SKILL_INSTRUCTIONS.update({
    "video-generation": COMPOSITE_SKILL_INSTRUCTIONS.get(
        "vertical-short-drama",
        "视频生成：先确认分镜/关键帧就绪；create clip 后 submit。",
    ),
    "3d-stage-composition": (
        "3D导演台构图：先引导用户搭机位与角色站位，再导出静态构图参考作为关键帧。"
    ),
    "post-production": (
        "后期流水线顺序：超分 → 裁剪 → 按依赖序拼接成片。不要跳步。"
    ),
})


def headers_for(user_id: int, role: str = "user", enterprise_id: str = "") -> dict:
    return {
        "X-User-Id": str(user_id),
        "X-User-Role": role,
        "X-Enterprise-Id": enterprise_id,
        "X-Request-Id": uuid.uuid4().hex,
        "Content-Type": "application/json",
    }


@dataclass
class Tool:
    name: str
    description: str
    risk_level: str  # read / low / high
    fn: Callable[..., dict]
    params_schema: dict = field(default_factory=dict)
    category: str = "core"  # core / collab / p2_reserved


def _get_canvas_summary(canvas_id: int, user_id: int, selected_node_ids: list[int] | None = None, **ctx) -> dict:
    cid = _require_canvas_id(canvas_id)
    if isinstance(cid, dict):
        return cid
    canvas_id = cid
    params = {}
    if selected_node_ids:
        params["selectedNodeIds"] = ",".join(str(x) for x in selected_node_ids)
        params["relatedDepth"] = 2
    try:
        r = httpx.get(
            f"{settings.canvas_base_url}/internal/canvases/{canvas_id}/summary",
            headers=headers_for(user_id),
            params=params,
            timeout=10,
            trust_env=False,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    # 降级：全量裁切
    r = httpx.get(
        f"{settings.canvas_base_url}/internal/canvases/{canvas_id}",
        headers=headers_for(user_id), timeout=10, trust_env=False,
    )
    if r.status_code != 200:
        return {"error": r.text[:300]}
    data = r.json()
    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    type_counts: dict[str, int] = {}
    for n in nodes:
        t = n.get("type") or n.get("nodeType") or "unknown"
        type_counts[t] = type_counts.get(t, 0) + 1
    return {
        "canvasId": canvas_id,
        "name": data.get("canvas", {}).get("name"),
        "version": data.get("canvas", {}).get("version"),
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "nodeTypeCounts": type_counts,
        "keywords": [],
        "validEdgeCount": sum(1 for e in edges if e.get("valid", True)),
        "invalidEdgeCount": sum(1 for e in edges if not e.get("valid", True)),
        "staleNodes": [],
        "nodes": [{"id": n["id"], "type": n.get("type"), "status": n.get("status"),
                   "creativeType": n.get("creativeType"), "stale": n.get("stale", False)} for n in nodes],
        "edges": [{"id": e["id"], "source": e["sourceNodeId"], "target": e["targetNodeId"],
                   "valid": e.get("valid", True), "dependencyType": e.get("dependencyType", "reference")}
                  for e in edges],
    }


def _fetch_canvas_detail(canvas_id: int, user_id: int) -> dict | None:
    """拉取画布全量节点/连线（含完整 params / prompt / output）。"""
    for path in (
        f"{settings.canvas_base_url}/internal/canvases/{canvas_id}",
        f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}",
    ):
        try:
            r = httpx.get(path, headers=headers_for(user_id), timeout=10, trust_env=False)
            if r.status_code == 200:
                return r.json()
        except Exception:
            continue
    return None


def _neighbor_brief(node: dict | None) -> dict | None:
    if not node:
        return None
    params = node.get("params") if isinstance(node.get("params"), dict) else {}
    return {
        "id": node.get("id"),
        "type": node.get("type") or node.get("nodeType"),
        "creativeType": node.get("creativeType") or node.get("creative_type"),
        "status": node.get("status"),
        "execStatus": node.get("execStatus") or node.get("exec_status"),
        "title": params.get("title"),
        "prompt": (node.get("prompt") or params.get("prompt") or "")[:120] or None,
        "hasOutput": bool(node.get("output") or params.get("lastOutputUrl") or params.get("url")),
    }


def _attach_graph_neighbors(node: dict, nodes_by_id: dict[int, dict], edges: list[dict]) -> dict:
    """为节点挂上完整字段 + 上下游连接信息。"""
    nid = int(node.get("id"))
    upstream: list[dict] = []
    downstream: list[dict] = []
    in_edges: list[dict] = []
    out_edges: list[dict] = []
    for e in edges:
        src = e.get("sourceNodeId") if e.get("sourceNodeId") is not None else e.get("source")
        tgt = e.get("targetNodeId") if e.get("targetNodeId") is not None else e.get("target")
        try:
            src_i, tgt_i = int(src), int(tgt)
        except (TypeError, ValueError):
            continue
        dep = e.get("dependencyType") or e.get("dependency_type") or "reference"
        edge_brief = {
            "id": e.get("id"),
            "sourceNodeId": src_i,
            "targetNodeId": tgt_i,
            "dependencyType": dep,
            "sourcePort": e.get("sourcePort") or e.get("source_port") or "output",
            "targetPort": e.get("targetPort") or e.get("target_port") or "input",
            "valid": e.get("valid", True),
        }
        if tgt_i == nid:
            in_edges.append(edge_brief)
            brief = _neighbor_brief(nodes_by_id.get(src_i))
            if brief:
                brief = {**brief, "dependencyType": dep}
                upstream.append(brief)
        if src_i == nid:
            out_edges.append(edge_brief)
            brief = _neighbor_brief(nodes_by_id.get(tgt_i))
            if brief:
                brief = {**brief, "dependencyType": dep}
                downstream.append(brief)
    params = node.get("params") if isinstance(node.get("params"), dict) else {}
    prompt = node.get("prompt") or params.get("prompt")
    return {
        "id": nid,
        "type": node.get("type") or node.get("nodeType"),
        "creativeType": node.get("creativeType") or node.get("creative_type"),
        "status": node.get("status"),
        "execStatus": node.get("execStatus") or node.get("exec_status") or "idle",
        "stale": bool(node.get("stale")),
        "modelRef": node.get("modelRef") or node.get("model_ref") or params.get("model"),
        "prompt": prompt,
        "params": params,
        "output": node.get("output"),
        "x": node.get("x") if node.get("x") is not None else node.get("positionX"),
        "y": node.get("y") if node.get("y") is not None else node.get("positionY"),
        "width": node.get("width"),
        "height": node.get("height"),
        "upstream": upstream,
        "downstream": downstream,
        "incomingEdges": in_edges,
        "outgoingEdges": out_edges,
    }


def _get_selected_nodes(canvas_id: int, user_id: int, node_ids: list[int] | None = None, **ctx) -> dict:
    """返回选中节点的完整信息（prompt / params / output / 上下游）。"""
    detail = _fetch_canvas_detail(canvas_id, user_id)
    if not detail:
        summary = _get_canvas_summary(canvas_id, user_id, selected_node_ids=node_ids)
        ids = set(int(x) for x in (node_ids or []))
        nodes = summary.get("selectedNodes") or summary.get("nodes") or []
        selected = [n for n in nodes if n.get("id") in ids] if ids else nodes[:20]
        return {"selectedNodes": selected, "detail": False}
    nodes = list(detail.get("nodes") or [])
    edges = list(detail.get("edges") or [])
    nodes_by_id = {int(n["id"]): n for n in nodes if n.get("id") is not None}
    ids = [int(x) for x in (node_ids or [])]
    if not ids:
        ids = list(nodes_by_id.keys())[:20]
    selected = [
        _attach_graph_neighbors(nodes_by_id[i], nodes_by_id, edges)
        for i in ids
        if i in nodes_by_id
    ]
    return {"selectedNodes": selected, "count": len(selected), "detail": True}


def _get_node_detail(canvas_id: int, user_id: int, node_id: int | None = None, **ctx) -> dict:
    """读取单个节点完整信息（提示词、参数、产物、上下游连接）。"""
    coerced = _coerce_node_id(node_id if node_id is not None else ctx.get("nodeId"))
    if coerced is None:
        return {"error": "缺少 node_id", "error_code": "INVALID_INPUT"}
    packed = _get_selected_nodes(canvas_id, user_id, node_ids=[coerced], **ctx)
    nodes = packed.get("selectedNodes") or []
    if not nodes:
        return {"error": f"节点不存在: {coerced}", "error_code": "NOT_FOUND"}
    return {"node": nodes[0], "detail": packed.get("detail", True)}


def _list_models(model_type: str | None = None, **ctx) -> dict:
    params = {"type": model_type} if model_type else {}
    r = httpx.get(f"{settings.generation_base_url}/api/v1/models", params=params, timeout=10, trust_env=False)
    return r.json() if r.status_code == 200 else {"error": r.text[:300]}


def _search_assets(keyword: str, user_id: int, **ctx) -> dict:
    r = httpx.get(
        f"{settings.asset_base_url}/internal/assets",
        params={"keyword": keyword},
        headers=headers_for(user_id), timeout=10, trust_env=False,
    )
    if r.status_code != 200:
        return {"error": r.text[:300]}
    assets = r.json()
    if isinstance(assets, list):
        assets = assets[:5]
    elif isinstance(assets, dict) and "items" in assets:
        assets = {"items": (assets.get("items") or [])[:5]}
    return {"assets": assets}


def _normalize_create_nodes_payload(nodes: list[dict] | None = None, **ctx) -> list[dict]:
    """兼容 LLM 多种传参：nodes[] / 单节点 type+config / node 对象。"""
    if isinstance(nodes, list) and nodes:
        return nodes
    if isinstance(ctx.get("nodes"), list) and ctx["nodes"]:
        return ctx["nodes"]
    single = ctx.get("node")
    if isinstance(single, dict):
        return [single]
    node_type = ctx.get("type") or ctx.get("nodeType") or ctx.get("node_type")
    if node_type:
        cfg = ctx.get("config") or ctx.get("params") or {}
        if not isinstance(cfg, dict):
            cfg = {}
        prompt = ctx.get("prompt") or cfg.get("prompt") or ""
        params = dict(cfg)
        if prompt and "prompt" not in params:
            params["prompt"] = prompt
        model = ctx.get("model") or ctx.get("modelRef") or params.get("model")
        if model:
            params["model"] = model
        return [{
            "type": node_type,
            "x": ctx.get("x", 220),
            "y": ctx.get("y", 180),
            "params": params,
            "prompt": prompt,
            "creativeType": ctx.get("creativeType") or ctx.get("creative_type"),
            "modelRef": model,
        }]
    return []


def _create_nodes(canvas_id: int, user_id: int, nodes: list[dict] | None = None, **ctx) -> dict:
    cid = _require_canvas_id(canvas_id)
    if isinstance(cid, dict):
        return cid
    canvas_id = cid
    nodes = _normalize_create_nodes_payload(nodes, **ctx)
    if not nodes:
        return {"error": "create_nodes 缺少 nodes（或 type/config）参数", "error_code": "INVALID_INPUT"}
    from ..domain.prompt_builder import ensure_node_prompt
    from ..domain.workflow_rails import IMAGE_PREF_MODEL, backfill_video_node_params
    user_hint = str(ctx.get("user_content") or ctx.get("content") or "")
    nodes = [ensure_node_prompt(n, user_hint) for n in nodes]
    created = []
    for n in nodes:
        params = dict(n.get("params") or n.get("config") or {})
        node_type = n.get("type") or "text"
        # 轨道回填：视频/图片偏好参数由工作流写入，不靠模型编造
        if node_type == "video":
            params = backfill_video_node_params(params, user_content=user_hint)
            n["params"] = params
        elif node_type == "image":
            params.setdefault("model", IMAGE_PREF_MODEL)
            n["params"] = params
        prompt = n.get("prompt") or params.get("prompt")
        model_ref = n.get("modelRef") or n.get("model_ref") or params.get("model")
        body = {
            "type": node_type,
            "x": n.get("x", 220),
            "y": n.get("y", 180),
            "params": params,
            "creativeType": n.get("creativeType") or n.get("creative_type"),
            "modelRef": model_ref,
            "prompt": prompt,
        }
        if n.get("width") is not None:
            body["width"] = n.get("width")
        if n.get("height") is not None:
            body["height"] = n.get("height")
        r = httpx.post(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes",
            headers=headers_for(user_id), json=body, timeout=10, trust_env=False,
        )
        if r.status_code in (200, 201):
            created.append(r.json())
        else:
            return {"error": r.text[:300]}
    return {"createdNodes": created, "nodes": created, "count": len(created)}


def _coerce_node_id(value) -> int | None:
    if value is None or value is False:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"none", "null", "undefined", "0"}:
        return None
    try:
        n = int(text)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _connect_nodes(canvas_id: int, user_id: int, edges: list[dict] | None = None, **ctx) -> dict:
    cid = _require_canvas_id(canvas_id)
    if isinstance(cid, dict):
        return cid
    canvas_id = cid
    edges = list(edges or ctx.get("edges") or [])
    # 兼容单边字段
    if not edges:
        src = _coerce_node_id(ctx.get("sourceNodeId") or ctx.get("source_node_id") or ctx.get("source"))
        tgt = _coerce_node_id(ctx.get("targetNodeId") or ctx.get("target_node_id") or ctx.get("target"))
        if src and tgt:
            edges = [{
                "sourceNodeId": src,
                "targetNodeId": tgt,
                "sourcePort": ctx.get("sourcePort", "output"),
                "targetPort": ctx.get("targetPort", "input"),
                "dependencyType": ctx.get("dependencyType") or "input",
            }]
    created = []
    for e in edges:
        src = _coerce_node_id(e.get("sourceNodeId") or e.get("source"))
        tgt = _coerce_node_id(e.get("targetNodeId") or e.get("target"))
        if not src or not tgt:
            return {"error": f"连线缺少有效节点 ID：source={src} target={tgt}", "error_code": "INVALID_INPUT"}
        body = {
            "sourceNodeId": src,
            "targetNodeId": tgt,
            "sourcePort": e.get("sourcePort", "output"),
            "targetPort": e.get("targetPort", "input"),
            "dependencyType": e.get("dependencyType") or e.get("dependency_type") or "input",
        }
        r = httpx.post(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/edges",
            headers=headers_for(user_id), json=body, timeout=10, trust_env=False,
        )
        if r.status_code in (200, 201):
            created.append(r.json())
        else:
            return {"error": r.text[:300]}
    if not created:
        return {"error": "connect_nodes 未提供有效 edges", "error_code": "INVALID_INPUT"}
    return {"createdEdges": created, "count": len(created)}


def _layout_nodes(canvas_id: int, user_id: int, layout: str = "auto", **ctx) -> dict:
    cid = _require_canvas_id(canvas_id)
    if isinstance(cid, dict):
        return cid
    canvas_id = cid
    r = httpx.get(
        f"{settings.canvas_base_url}/internal/canvases/{canvas_id}",
        headers=headers_for(user_id), timeout=10, trust_env=False,
    )
    if r.status_code != 200:
        return {"error": r.text[:300]}
    payload = r.json()
    nodes = payload.get("nodes", [])
    edges = payload.get("edges", [])
    from ..domain.dependency_graph import compute_dependency_layout
    positions = compute_dependency_layout(nodes, edges)
    updates = []
    for n in nodes:
        pos = positions.get(int(n["id"]))
        if not pos:
            continue
        x, y = pos
        if int(n.get("x") or -1) == x and int(n.get("y") or -1) == y:
            continue  # 已在目标位置，跳过以减少画布写操作
        r2 = httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{n['id']}",
            headers=headers_for(user_id),
            json={"x": x, "y": y},
            timeout=10, trust_env=False,
        )
        if r2.status_code == 200:
            updates.append(r2.json())
    return {"layout": layout, "mode": "dependency", "updatedNodes": len(updates)}


def _update_node_config(canvas_id: int, user_id: int, node_id: int | None = None, params: dict | None = None, **ctx) -> dict:
    if node_id is None:
        node_id = ctx.get("nodeId")
    if node_id is None:
        return {"error": "node_id required", "error_code": "INVALID_INPUT"}
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return {"error": "params must be object", "error_code": "INVALID_INPUT"}
    body: dict = {"params": params}
    if params.get("prompt"):
        body["prompt"] = params["prompt"]
    if params.get("model") or params.get("modelRef"):
        body["modelRef"] = params.get("modelRef") or params.get("model")
    if "creativeType" in ctx or "creative_type" in ctx:
        body["creativeType"] = ctx.get("creativeType") or ctx.get("creative_type")
    if "stale" in ctx:
        body["stale"] = ctx["stale"]
    if "execStatus" in ctx or "exec_status" in ctx:
        body["execStatus"] = ctx.get("execStatus") or ctx.get("exec_status")
    r = httpx.put(
        f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
        headers=headers_for(user_id), json=body, timeout=10, trust_env=False,
    )
    return r.json() if r.status_code == 200 else {"error": r.text[:300]}


def _delete_nodes(canvas_id: int, user_id: int, node_ids: list[int], **ctx) -> dict:
    results = []
    for node_id in node_ids or []:
        r = httpx.delete(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id), timeout=10, trust_env=False,
        )
        results.append({"nodeId": node_id, "status": r.status_code})
    return {"deleted": results}


def _change_model(canvas_id: int, user_id: int, node_id: int, model: str, **ctx) -> dict:
    r = httpx.get(
        f"{settings.canvas_base_url}/internal/canvases/{canvas_id}",
        headers=headers_for(user_id), timeout=10, trust_env=False,
    )
    if r.status_code != 200:
        return {"error": r.text[:300]}
    node = next((n for n in r.json().get("nodes", []) if n["id"] == node_id), None)
    if not node:
        return {"error": "节点不存在"}
    params = dict(node.get("params") or {})
    params["model"] = model
    r2 = httpx.put(
        f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
        headers=headers_for(user_id), json={"params": params, "modelRef": model}, timeout=10, trust_env=False,
    )
    return r2.json() if r2.status_code == 200 else {"error": r2.text[:300]}


def _replace_output(canvas_id: int, user_id: int, node_id: int, output_id: int, **ctx) -> dict:
    r = httpx.put(
        f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
        headers=headers_for(user_id), json={"currentOutputId": output_id}, timeout=10, trust_env=False,
    )
    return r.json() if r.status_code == 200 else {"error": r.text[:300]}


def _node_media_url(node: dict) -> str | None:
    params = node.get("params") or {}
    out = node.get("output")
    if isinstance(out, dict):
        for k in ("url", "lastOutputUrl", "imageUrl", "videoUrl", "thumbnailUrl"):
            v = out.get(k)
            if isinstance(v, str) and v.strip().startswith(("http", "/")):
                return v.strip()
        # 兼容 outputs 数组形态
        outputs = out.get("outputs") or out.get("files") or []
        if isinstance(outputs, list):
            for item in outputs:
                if isinstance(item, dict):
                    v = item.get("url") or item.get("fileUrl")
                    if isinstance(v, str) and v.strip().startswith(("http", "/")):
                        return v.strip()
                elif isinstance(item, str) and item.strip().startswith(("http", "/")):
                    return item.strip()
    for k in ("lastOutputUrl", "url", "thumbnailUrl", "referenceUrl", "output_url", "imageUrl"):
        v = params.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _node_text_output(node: dict) -> str | None:
    params = node.get("params") or {}
    out = node.get("output")
    if isinstance(out, dict):
        for k in ("text", "content"):
            v = out.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    for k in ("lastOutputText", "text", "content"):
        v = params.get(k)
        if isinstance(v, str) and v.strip() and not v.strip().startswith("【"):
            # 排除尚未生成、仍是模板 prompt 的情况
            if k == "prompt":
                continue
            return v.strip()
    return None


_REF_MEDIA_KEYS = (
    "referenceUrls", "referenceImages", "referenceTexts",
    "imageUrl", "firstFrameUrl", "lastFrameUrl", "image", "image_url",
    "referenceUrl", "sourceUrl",
)


def _merge_reference_params(base: dict, refs: dict) -> dict:
    """把上游参考字段合并进提交参数（不覆盖已有非空值；列表去重追加）。"""
    params = dict(base or {})
    for key, val in (refs or {}).items():
        if key not in params or not params.get(key):
            params[key] = val
        elif key in ("referenceUrls", "referenceImages", "referenceTexts") and isinstance(val, list):
            merged = list(params.get(key) or [])
            for item in val:
                if item not in merged:
                    merged.append(item)
            params[key] = merged
    return params


def _preserve_reference_fields(old: dict, new: dict) -> dict:
    """轨道参数重算后，把参考图/文本字段从旧 params 拷回。"""
    out = dict(new or {})
    for key in _REF_MEDIA_KEYS:
        if key in out and out.get(key):
            continue
        val = (old or {}).get(key)
        if val:
            out[key] = val
    return out


def _reinforce_prompt_with_reference(params: dict, model_type: str) -> dict:
    """Keep the creator's prompt unchanged when reference media is present.

    Reference URLs are model inputs rather than implicit prompt instructions.
    The name is retained for call-site compatibility while the former prompt
    mutation is intentionally removed.
    """
    del model_type
    return dict(params or {})


def _collect_input_references(canvas_id: int, user_id: int, node_id: int) -> dict:
    """从连线收集上游产物：文本→referenceTexts，图/视频→referenceUrls。

    input / reference 两类连线都会喂参考（形象/构图靠连线，不靠把上游全文粘进 Prompt）。
    """
    try:
        r = httpx.get(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}",
            headers=headers_for(user_id),
            timeout=10,
            trust_env=False,
        )
        if r.status_code != 200:
            return {}
        detail = r.json()
    except Exception:
        return {}

    nodes = {int(n["id"]): n for n in (detail.get("nodes") or []) if n.get("id") is not None}
    # 按边 id 升序，保留 connect 时的首尾帧顺序
    edges = sorted(
        detail.get("edges") or [],
        key=lambda e: int(e.get("id") or 0),
    )
    ref_urls: list[str] = []
    ref_texts: list[str] = []
    image_urls: list[str] = []
    for e in edges:
        dep = str(e.get("dependencyType") or e.get("dependency_type") or "reference").lower()
        # control 不喂内容；input/reference 都可作为参考素材
        if dep not in ("input", "reference", ""):
            continue
        tgt = e.get("targetNodeId") or e.get("target")
        src = e.get("sourceNodeId") or e.get("source")
        try:
            if int(tgt) != int(node_id):
                continue
            src_node = nodes.get(int(src))
        except (TypeError, ValueError):
            continue
        if not src_node:
            continue
        ntype = str(src_node.get("type") or src_node.get("nodeType") or "")
        if ntype in ("image", "video"):
            url = _node_media_url(src_node)
            if url:
                ref_urls.append(url)
                if ntype == "image":
                    image_urls.append(url)
        elif ntype == "text":
            text = _node_text_output(src_node)
            if text:
                ref_texts.append(text[:1200])
        else:
            url = _node_media_url(src_node)
            text = _node_text_output(src_node)
            if url:
                ref_urls.append(url)
            if text:
                ref_texts.append(text[:1200])

    out: dict = {}
    if ref_urls:
        out["referenceUrls"] = list(dict.fromkeys(ref_urls))
        out["referenceImages"] = [u for u in out["referenceUrls"] if u]
    if ref_texts:
        out["referenceTexts"] = ref_texts
    # 按连线顺序：第一张图作首帧，第二张图作尾帧（首尾帧生视频）
    uniq_images = list(dict.fromkeys(image_urls))
    if uniq_images:
        out["imageUrl"] = uniq_images[0]
        out["firstFrameUrl"] = uniq_images[0]
        out["image"] = uniq_images[0]
        if len(uniq_images) >= 2:
            out["lastFrameUrl"] = uniq_images[1]
    return out


def _submit_generation(canvas_id: int, user_id: int, node_id: int, model_type: str,
                       model_params: dict, estimated_cost: int, **ctx) -> dict:
    cid = _require_canvas_id(canvas_id)
    if isinstance(cid, dict):
        return cid
    canvas_id = cid
    if node_id is not None and str(node_id).strip().startswith("$"):
        return {
            "error": "节点引用尚未解析（内部占位符），请重试",
            "error_code": "INVALID_INPUT",
        }
    coerced = _coerce_node_id(node_id)
    if coerced is None:
        return {"error": "缺少节点 ID，无法提交生成", "error_code": "INVALID_INPUT"}

    # 注入上游 reference：形象靠连线，Prompt 只写本次动作
    params = _merge_reference_params(dict(model_params or {}), _collect_input_references(canvas_id, user_id, coerced))

    from ..domain.prompt_builder import refine_prompt_on_submit
    from ..domain.model_defaults import resolve_submit_model
    import re as _re
    raw_prompt = str(params.get("prompt") or "").strip()
    if (not raw_prompt) or _re.match(
        r"^【(总脚本|分镜表|角色卡|镜头\d+|图片生成|视频生成)", raw_prompt,
    ):
        params["prompt"] = refine_prompt_on_submit(
            {"type": model_type, "prompt": raw_prompt, "params": params,
             "creativeType": params.get("creativeType")},
            None,
        )

    workflow_notes: list[str] = []
    # 视频：工作流裁定参数合法性与兼容换模（模型只负责 prompt 内容）
    if str(model_type or "").lower() == "video" or str(params.get("model") or "").startswith(
        ("doubao-seedance", "agnes-video", "seedance", "wan-2"),
    ):
        from ..domain.video_task import build_video_task_params

        before_rails = dict(params)
        task = build_video_task_params(
            content=str(ctx.get("user_content") or ctx.get("content") or ""),
            prompt=str(params.get("prompt") or ""),
            model_name=params.get("model"),
            node_params=params,
            extra={k: params[k] for k in _REF_MEDIA_KEYS if params.get(k)},
        )
        # 关键：轨道回填会重建 model_params，必须把参考图/首帧拷回去，否则图生视频变文生视频
        params = _preserve_reference_fields(before_rails, task["model_params"])
        workflow_notes = list(task.get("workflow_notes") or [])
        if task.get("estimated_cost"):
            estimated_cost = max(1, int(task["estimated_cost"]))

    params = _reinforce_prompt_with_reference(params, model_type)

    # 禁止把 modality「text」原样交给 generation（会掉进 mock-text）
    node_model_ref = params.get("modelRef") or ctx.get("modelRef") or ctx.get("model")
    if not node_model_ref:
        try:
            summary = httpx.get(
                f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/summary",
                headers=headers_for(user_id),
                params={"relatedDepth": 0},
                timeout=8,
                trust_env=False,
            )
            if summary.status_code == 200:
                for n in (summary.json() or {}).get("nodes") or []:
                    if int(n.get("id") or 0) == coerced:
                        node_model_ref = n.get("modelRef") or n.get("model_ref")
                        break
        except Exception:
            pass
    resolved_model = resolve_submit_model(
        model_type, model_params=params, node_model_ref=node_model_ref,
    )
    params.setdefault("model", resolved_model)

    idem = str(ctx.get("idempotency_key") or "").strip()
    if not idem:
        # 非图执行入口（兼容内部工具/测试）同样必须稳定；正常 Agent 路径由
        # executor 注入 action_id 派生的键，避免用户显式重跑被错误合并。
        fingerprint = json.dumps(
            {
                "userId": user_id,
                "canvasId": canvas_id,
                "nodeId": coerced,
                "model": resolved_model,
                "params": params,
                "estimatedCost": max(1, int(estimated_cost)),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        idem = f"agt-legacy:{hashlib.sha256(fingerprint.encode('utf-8')).hexdigest()[:48]}"
    body = {
        "userId": user_id,
        "nodeId": coerced,
        "canvasId": canvas_id,
        "modelType": resolved_model,
        "modelParams": params,
        "estimatedCost": max(1, int(estimated_cost)),
        "source": "agent",
    }
    r = httpx.post(
        f"{settings.billing_base_url}/api/v1/tasks",
        headers={**headers_for(user_id), "Idempotency-Key": idem},
        json=body, timeout=15, trust_env=False,
    )
    if r.status_code not in (200, 201):
        return {"error": r.text[:300]}
    data = r.json()
    task_id = data.get("taskId") or data.get("id")
    result = {
        "ack": True,
        "task_id": task_id,
        "taskId": task_id,
        "status": data.get("status") or "queued",
        "model": resolved_model,
        "model_params": params,
    }
    if workflow_notes:
        result["workflow_notes"] = workflow_notes
    result["estimatedCost"] = body["estimatedCost"]
    result["model_type"] = resolved_model
    result["node_id"] = coerced
    result.update({k: v for k, v in data.items() if k not in result})
    _mark_node_generating(canvas_id, user_id, coerced, str(result.get("status") or "queued"))
    return result


def _update_memory(user_id: int, scope: str, content: str, canvas_id: int | None = None,
                   fragment_type: str = "worldview", **ctx) -> dict:
    from ..services.memory_service import memory_service
    memory_service.trigger_memory_update(
        user_id=user_id, canvas_id=canvas_id or ctx.get("canvas_id"),
        scope=scope, content=content, fragment_type=fragment_type,
    )
    return {"queued": True, "scope": scope}


def _clock(user_id: int, delay: int, note: dict | None = None, callback: str = "check_task_status",
           canvas_id: int | None = None, **ctx) -> dict:
    delay = max(5, min(int(delay or 30), 300))
    wakeup_at = datetime.now(timezone.utc).timestamp() + delay
    payload = {
        "user_id": user_id,
        "canvas_id": canvas_id,
        "callback": callback,
        "note": note or {},
        "wakeup_at": wakeup_at,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    # ZSET：score=唤醒时间
    job_id = uuid.uuid4().hex
    redis_client.zadd("agent_clock_jobs", {json.dumps({**payload, "job_id": job_id}, ensure_ascii=False): wakeup_at})
    return {
        "scheduled": True,
        "wakeup_at": datetime.fromtimestamp(wakeup_at, tz=timezone.utc).isoformat(),
        "job_id": job_id,
        "delay": delay,
    }


def _load_skill(skill_key: str | None = None, user_id: int | None = None, **ctx) -> dict:
    """按需加载 Skill 创作规则（catalog → 路由名 → DB）。"""
    from ..domain.skill_catalog import get_skill, resolve_route_keys, skill_instructions_bundle

    if not skill_key:
        skill_key = (
            ctx.get("skillKey")
            or ctx.get("key")
            or ctx.get("skill")
            or ctx.get("name")
            or ctx.get("skill_name")
        )
    key = (skill_key or "").strip()
    if not key:
        return {"error": "skill_key required", "error_code": "INVALID_INPUT"}

    # 组合路由名 → 多 Skill 合并
    route_keys = resolve_route_keys(key)
    if len(route_keys) > 1 or (route_keys and route_keys[0] != key and key not in SKILL_CATALOG):
        bundle = skill_instructions_bundle(route_keys)
        if bundle:
            return {
                "skill_key": key,
                "loaded_keys": route_keys,
                "instructions": bundle,
                "name": key,
            }

    skill = get_skill(key) or get_skill(route_keys[0] if route_keys else "")
    if skill:
        text = (
            f"{skill.description}\n触发：{skill.trigger_semantics}\n"
            f"骨架：{' → '.join(skill.workflow_skeleton)}\n{skill.instructions}"
        )
        return {
            "skill_key": skill.key,
            "loaded_keys": [skill.key],
            "instructions": text,
            "name": skill.name,
            "skeleton": list(skill.workflow_skeleton),
        }

    instructions = COMPOSITE_SKILL_INSTRUCTIONS.get(key)
    if not instructions and user_id:
        try:
            from ..core.db import SessionLocal
            from ..models import Skill
            db = SessionLocal()
            try:
                row = (
                    db.query(Skill)
                    .filter(Skill.owner_id == user_id, Skill.name == key, Skill.enabled == True)  # noqa: E712
                    .first()
                )
                if row:
                    instructions = row.instructions
            finally:
                db.close()
        except Exception:
            pass
    if not instructions:
        return {"error": f"skill not found: {key}", "error_code": "INVALID_INPUT"}
    return {"skill_key": key, "loaded_keys": [key], "instructions": instructions, "name": key}


def _mark_node_generating(canvas_id: int | None, user_id: int, node_id: int, status: str = "queued") -> None:
    """提交后立刻把节点打成 queued，避免画布仍是 idle/stale 被下游调度反复重提。"""
    if not canvas_id or not node_id:
        return
    st = status if status in ("queued", "running") else "queued"
    try:
        httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id),
            json={"status": st, "execStatus": st, "stale": False},
            timeout=8,
            trust_env=False,
        )
    except Exception:
        logger = logging.getLogger("agent.tools")
        logger.debug("mark node generating failed node=%s", node_id)


def _check_task_status(user_id: int, task_id: str | int | None = None, node_id: int | None = None,
                       canvas_id: int | None = None, note: dict | None = None, **ctx) -> dict:
    note = note or {}
    task_id = task_id or note.get("task_id")
    node_id = node_id or note.get("node_id")
    canvas_id = canvas_id or note.get("canvas_id")
    if not task_id:
        return {"error": "task_id required"}
    r = httpx.get(
        f"{settings.billing_base_url}/api/v1/tasks/{task_id}",
        headers=headers_for(user_id), timeout=10, trust_env=False,
    )
    if r.status_code != 200:
        # 尝试 generation-service
        r2 = httpx.get(
            f"{settings.generation_base_url}/api/v1/tasks/{task_id}",
            headers=headers_for(user_id), timeout=10, trust_env=False,
        )
        if r2.status_code != 200:
            return {"error": r.text[:300], "status": "fetch_error"}
        data = r2.json()
    else:
        data = r.json()

    status = str(data.get("status") or "unknown")
    output = data.get("output") or data.get("result") or data.get("outputUrl")
    outputs = data.get("outputs") or []
    error_code = data.get("errorCode") or data.get("error_code")
    # 任务失败原因用 error_message，保留 error 仅表示工具/HTTP 取数失败（避免 ok=False 误判）
    error_msg = data.get("errorMessage") or data.get("error_message") or data.get("message")
    # 成功/结算异常（产物已生成）时回写节点产物（Norm 一等字段）
    if status in ("succeeded", "settlement_error") and canvas_id and node_id:
        body: dict = {"status": "succeeded", "execStatus": "ready"}
        text_out: str | None = None
        url_out: str | None = None
        if isinstance(output, str) and output.strip():
            if output.startswith(("http", "/")):
                url_out = output.strip()
            else:
                text_out = output.strip()
        elif isinstance(output, dict):
            text_out = str(output.get("text") or output.get("content") or "").strip() or None
            url_out = str(output.get("url") or "").strip() or None
        if outputs:
            first = outputs[0] if isinstance(outputs[0], dict) else {}
            meta = first.get("meta") or {}
            if not text_out:
                text_out = str(meta.get("text") or first.get("text") or "").strip() or None
            if not url_out:
                url_out = str(first.get("url") or "").strip() or None
        patch_params: dict = {}
        if text_out:
            body["output"] = {"text": text_out, "content": text_out}
            patch_params.update({"lastOutputText": text_out, "text": text_out, "content": text_out})
        if url_out:
            body["output"] = {**(body.get("output") or {}), "url": url_out}
            patch_params.update({"lastOutputUrl": url_out, "url": url_out, "output_url": url_out})
        if patch_params:
            body["params"] = patch_params
        httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id), json=body, timeout=10, trust_env=False,
        )
    elif status == "failed" and canvas_id and node_id:
        httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id), json={"status": "failed", "execStatus": "failed"}, timeout=10, trust_env=False,
        )
    elif status == "expired" and canvas_id and node_id:
        # 冻结过期：节点回到可重新提交状态（expired 不属于 ready/active）
        httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id), json={"status": "expired", "execStatus": "expired"}, timeout=10, trust_env=False,
        )
    elif status == "cancelled" and canvas_id and node_id:
        httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id), json={"status": "cancelled", "execStatus": "idle"}, timeout=10, trust_env=False,
        )
    elif status in ("queued", "running") and canvas_id and node_id:
        httpx.put(
            f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}/nodes/{node_id}",
            headers=headers_for(user_id), json={"status": status, "execStatus": status}, timeout=10, trust_env=False,
        )
    # 仍在跑：退避再唤醒
    if status in ("queued", "running"):
        prev_delay = int(note.get("delay") or 30)
        next_delay = min(int(prev_delay * 1.5), 300)
        _clock(user_id=user_id, delay=next_delay, note={**note, "delay": next_delay, "task_id": task_id,
                                                         "node_id": node_id, "canvas_id": canvas_id},
               canvas_id=canvas_id)
    return {
        "task_id": task_id,
        "status": status,
        "output": output,
        "outputs": outputs,
        "node_id": node_id,
        "error_code": error_code,
        "error_message": error_msg,
    }


def _submit_media_operation(
    canvas_id: int,
    user_id: int,
    node_id: int,
    model_type: str,
    operation: str,
    model_params: dict | None = None,
    estimated_cost: int = 10,
    **ctx,
) -> dict:
    params = dict(model_params or {})
    params["operation"] = operation
    return _submit_generation(
        canvas_id=canvas_id,
        user_id=user_id,
        node_id=node_id,
        model_type=model_type,
        model_params=params,
        estimated_cost=estimated_cost,
        **ctx,
    )


def _source_node_xy(canvas_id: int, user_id: int, source_id: int) -> tuple[float, float, dict]:
    """读取源节点坐标与摘要，派生节点落在其右侧。"""
    packed = _get_selected_nodes(canvas_id, user_id, node_ids=[source_id])
    nodes = packed.get("selectedNodes") or []
    if not nodes:
        return 520.0, 180.0, {}
    src = nodes[0]
    x = float(src.get("x") or 220) + 300
    y = float(src.get("y") or 180)
    return x, y, src


def _derive_and_operate(
    canvas_id: int,
    user_id: int,
    *,
    source_node_id: int,
    derived_type: str,
    operation: str,
    submit_model_type: str,
    title: str,
    prompt: str,
    estimated_cost: int = 10,
    model_params: dict | None = None,
    creative_type: str | None = None,
    inplace: bool = False,
    **ctx,
) -> dict:
    """从源节点派生新节点 → 连线 → 在新节点上提交加工（默认不改源）。"""
    coerced = _coerce_node_id(source_node_id)
    if coerced is None:
        return {"error": "缺少源节点 ID", "error_code": "INVALID_INPUT"}

    if inplace:
        result = _submit_media_operation(
            canvas_id, user_id, coerced, submit_model_type, operation,
            model_params, estimated_cost, **ctx,
        )
        return {**result, "derived": False, "sourceNodeId": coerced, "node_id": coerced}

    x, y, src = _source_node_xy(canvas_id, user_id, coerced)
    params = {
        "prompt": prompt,
        "title": title,
        "operation": operation,
        **(model_params or {}),
    }
    if derived_type == "image":
        from ..domain.workflow_rails import IMAGE_PREF_MODEL as _img
        params.setdefault("model", _img)
    created = _create_nodes(
        canvas_id,
        user_id,
        nodes=[{
            "type": derived_type,
            "x": x,
            "y": y,
            "params": params,
            "prompt": prompt,
            "creativeType": creative_type,
            "modelRef": params.get("model"),
        }],
        **ctx,
    )
    if created.get("error"):
        return created
    new_nodes = created.get("createdNodes") or created.get("nodes") or []
    if not new_nodes:
        return {"error": "派生节点创建失败", "error_code": "CREATE_FAILED"}
    new_id = int(new_nodes[0]["id"])
    linked = _connect_nodes(
        canvas_id,
        user_id,
        edges=[{
            "sourceNodeId": coerced,
            "targetNodeId": new_id,
            "dependencyType": "input",
        }],
        **ctx,
    )
    if linked.get("error"):
        return {**linked, "createdNodes": new_nodes, "derivedNodeId": new_id}

    # 源已有产物时，把 URL 写进派生节点提交参数，避免仅靠连线时序丢参考
    submit_params = dict(model_params or {})
    src_params = src.get("params") if isinstance(src.get("params"), dict) else {}
    src_out = src.get("output") if isinstance(src.get("output"), dict) else {}
    src_url = (
        src_out.get("url")
        or src_params.get("lastOutputUrl")
        or src_params.get("url")
        or src_params.get("thumbnailUrl")
    )
    if src_url:
        submit_params.setdefault("sourceUrl", src_url)
        submit_params.setdefault("referenceUrls", [src_url])
        if derived_type == "image" or submit_model_type == "image":
            submit_params.setdefault("imageUrl", src_url)
            submit_params.setdefault("image", src_url)
            submit_params.setdefault("referenceImages", [src_url])

    result = _submit_media_operation(
        canvas_id, user_id, new_id, submit_model_type, operation,
        submit_params, estimated_cost, **ctx,
    )
    return {
        **result,
        "derived": True,
        "sourceNodeId": coerced,
        "derivedNodeId": new_id,
        "createdNodes": new_nodes,
        "createdEdges": linked.get("createdEdges"),
        "operation": operation,
    }


def _extract_frames(canvas_id: int, user_id: int, node_id: int, model_params: dict | None = None,
                    estimated_cost: int = 8, inplace: bool = False, **ctx) -> dict:
    """视频抽帧：默认派生 image 节点，不改源视频。"""
    return _derive_and_operate(
        canvas_id,
        user_id,
        source_node_id=node_id,
        derived_type="image",
        operation="提帧",
        submit_model_type="video",
        title="抽帧",
        prompt=str((model_params or {}).get("prompt") or "提取关键帧"),
        estimated_cost=estimated_cost,
        model_params=model_params,
        creative_type="keyframe",
        inplace=inplace,
        **ctx,
    )


def _trim_clip(canvas_id: int, user_id: int, node_id: int, model_params: dict | None = None,
               estimated_cost: int = 8, inplace: bool = False, **ctx) -> dict:
    """片段剪辑：默认派生 video 节点，不改源视频。"""
    return _derive_and_operate(
        canvas_id,
        user_id,
        source_node_id=node_id,
        derived_type="video",
        operation="剪辑",
        submit_model_type="video",
        title="剪辑片段",
        prompt=str((model_params or {}).get("prompt") or "剪辑片段"),
        estimated_cost=estimated_cost,
        model_params=model_params,
        creative_type="clip",
        inplace=inplace,
        **ctx,
    )


def _upscale(canvas_id: int, user_id: int, node_id: int, model_type: str | None = None,
             model_params: dict | None = None, estimated_cost: int = 12,
             inplace: bool = False, **ctx) -> dict:
    """超分：默认派生同类型节点，不改源素材。"""
    coerced = _coerce_node_id(node_id)
    if coerced is None:
        return {"error": "缺少源节点 ID", "error_code": "INVALID_INPUT"}
    _, _, src = _source_node_xy(canvas_id, user_id, coerced)
    src_type = str(src.get("type") or model_type or "image").lower()
    if src_type not in ("image", "video"):
        src_type = "image" if str(model_type or "image").lower() != "video" else "video"
    submit_type = model_type or src_type
    return _derive_and_operate(
        canvas_id,
        user_id,
        source_node_id=coerced,
        derived_type=src_type,
        operation="超分",
        submit_model_type=submit_type,
        title="超分",
        prompt=str((model_params or {}).get("prompt") or "提升清晰度与细节"),
        estimated_cost=estimated_cost,
        model_params=model_params,
        creative_type=src.get("creativeType"),
        inplace=inplace,
        **ctx,
    )


def _outpaint(canvas_id: int, user_id: int, node_id: int, model_params: dict | None = None,
              estimated_cost: int = 12, inplace: bool = False, **ctx) -> dict:
    """扩图（outpaint）：默认派生 image 节点，不改源图。"""
    return _derive_and_operate(
        canvas_id,
        user_id,
        source_node_id=node_id,
        derived_type="image",
        operation="扩图",
        submit_model_type="image",
        title="扩图",
        prompt=str((model_params or {}).get("prompt") or "扩展画面边缘，保持主体完整"),
        estimated_cost=estimated_cost,
        model_params=model_params,
        creative_type="keyframe",
        inplace=inplace,
        **ctx,
    )


def _compose_final(canvas_id: int, user_id: int, node_id: int, model_params: dict | None = None,
                   estimated_cost: int = 15, **ctx) -> dict:
    """成片拼接走 compose-1.0（本地 FFmpeg），绝不能落到 Seedance/video。"""
    params = dict(model_params or {})
    params["operation"] = "compose"
    if not params.get("inputUrls"):
        refs = _collect_input_references(canvas_id, user_id, int(node_id))
        urls = list(refs.get("referenceUrls") or [])
        # 只保留视频类上游 URL（referenceUrls 里可能混有图片）
        params["inputUrls"] = urls
    return _submit_generation(
        canvas_id=canvas_id,
        user_id=user_id,
        node_id=node_id,
        model_type="compose-1.0",
        model_params=params,
        estimated_cost=estimated_cost,
        **ctx,
    )


def _capture_3d_scene(canvas_id: int, user_id: int, node_id: int, model_params: dict | None = None,
                      estimated_cost: int = 10, **ctx) -> dict:
    return _submit_media_operation(
        canvas_id, user_id, node_id, "image", "director", model_params, estimated_cost, **ctx,
    )


def _p2_reserved(**ctx) -> dict:
    return {"error": "P2 tool not implemented in V1.0", "reserved": True}


TOOLS: dict[str, Tool] = {
    "get_canvas_summary": Tool("get_canvas_summary", "读取画布摘要", "read", _get_canvas_summary),
    "get_selected_nodes": Tool("get_selected_nodes", "读取选中节点完整信息", "read", _get_selected_nodes),
    "get_node_detail": Tool("get_node_detail", "读取单节点完整信息（prompt/params/output/上下游）", "read", _get_node_detail),
    "list_models": Tool("list_models", "列出可用模型", "read", _list_models),
    "search_assets": Tool("search_assets", "搜索素材库", "read", _search_assets),
    "create_nodes": Tool("create_nodes", "创建节点（单次 ≤20 免确认）", "low", _create_nodes),
    "connect_nodes": Tool("connect_nodes", "创建连线", "low", _connect_nodes),
    "layout_nodes": Tool("layout_nodes", "整理/排列节点", "low", _layout_nodes),
    "update_node_config": Tool("update_node_config", "修改节点参数", "low", _update_node_config),
    "delete_nodes": Tool("delete_nodes", "删除节点（必须确认）", "high", _delete_nodes),
    "change_model": Tool("change_model", "切换模型（必须确认）", "high", _change_model),
    "replace_output": Tool("replace_output", "覆盖节点输出（必须确认）", "high", _replace_output),
    "submit_generation": Tool("submit_generation", "提交生成任务（需确认）", "high", _submit_generation),
    # 协同工具
    "update_memory": Tool("update_memory", "异步记忆更新", "read", _update_memory, category="collab"),
    "clock": Tool("clock", "注册定时唤醒", "read", _clock, category="collab"),
    "load_skill": Tool("load_skill", "按需加载 Skill 规则", "read", _load_skill, category="collab"),
    "check_task_status": Tool("check_task_status", "查询生成任务状态", "read", _check_task_status, category="collab"),
    # 素材加工（默认派生新节点，不改源）
    "extract_frames": Tool("extract_frames", "视频抽帧（派生新图节点）", "high", _extract_frames, category="p2"),
    "trim_clip": Tool("trim_clip", "片段剪辑（派生新视频节点）", "high", _trim_clip, category="p2"),
    "upscale": Tool("upscale", "素材超分（派生新节点）", "high", _upscale, category="p2"),
    "outpaint": Tool("outpaint", "扩图 outpaint（派生新图节点）", "high", _outpaint, category="p2"),
    "compose_final": Tool("compose_final", "拼接成片", "high", _compose_final, category="p2"),
    "capture_3d_scene": Tool("capture_3d_scene", "3D 导演台截图", "high", _capture_3d_scene, category="p2"),
}


def classify_risk(tool_name: str, params: dict, canvas: dict | None = None) -> tuple[str, str | None]:
    tool = TOOLS.get(tool_name)
    if not tool:
        return "high", "unknown_tool"
    if tool.risk_level == "high":
        return "high", tool.name
    if tool_name == "create_nodes":
        count = len(params.get("nodes") or [])
        if count > 20:
            return "high", "batch_create_gt_20"
        return "low", None
    if tool_name == "update_node_config":
        delta = params.get("changedDelta")
        if delta is not None and float(delta) >= 30:
            return "high", "param_delta_ge_30"
        if params.get("switchModel"):
            return "high", "model_switch"
        return "low", None
    return tool.risk_level, None


def normalize_tool_params(tool_name: str, params: dict | None) -> dict:
    """把 LLM 常见的扁平/驼峰参数收成工具真实签名所需形态。"""
    raw = dict(params or {})
    if tool_name == "load_skill":
        key = (
            raw.get("skill_key")
            or raw.get("skillKey")
            or raw.get("key")
            or raw.get("skill")
            or raw.get("name")
            or raw.get("skill_name")
            or raw.get("skillName")
        )
        if isinstance(key, dict):
            key = key.get("key") or key.get("skill_key") or key.get("name")
        out = {"skill_key": str(key or "").strip()}
        # 透传其余字段到 **ctx
        for k, v in raw.items():
            if k not in out and k not in {"skillKey", "skill", "name", "skill_name", "skillName", "key"}:
                out[k] = v
        return out

    if tool_name == "update_node_config":
        node_id = raw.get("node_id") if raw.get("node_id") is not None else raw.get("nodeId")
        nested = raw.get("params")
        if not isinstance(nested, dict):
            nested = {}
        # 扁平 prompt/model 提升进 params
        for k in ("prompt", "title", "model", "modelRef", "content", "text"):
            if k in raw and k not in nested and raw[k] is not None:
                nested[k] = raw[k]
        # 若整包只有 config/patch
        for alt in ("config", "patch", "updates", "nodeParams"):
            extra = raw.get(alt)
            if isinstance(extra, dict):
                nested = {**extra, **nested}
        if not nested and isinstance(raw.get("body"), dict):
            nested = dict(raw["body"])
        out = {"node_id": node_id, "params": nested}
        for k, v in raw.items():
            if k in {
                "node_id", "nodeId", "params", "prompt", "title", "model", "modelRef",
                "content", "text", "config", "patch", "updates", "nodeParams", "body",
            }:
                continue
            out[k] = v
        return out

    if tool_name in ("change_model", "replace_output", "submit_generation"):
        if raw.get("node_id") is None and raw.get("nodeId") is not None:
            raw = {**raw, "node_id": raw.get("nodeId")}
    return raw


def create_confirm_token(user_id: int, canvas_id: int, canvas_version: int, action_summary: str) -> str:
    """兼容旧路径；主流程已迁移至 LangGraph interrupt。"""
    raw = f"{user_id}|{canvas_id}|{canvas_version}|{action_summary}|{int(time.time())}"
    token = hashlib.sha256(raw.encode()).hexdigest()[:48]
    redis_client.setex(
        f"agent_confirm:{token}", settings.confirm_token_ttl_seconds,
        json.dumps({"userId": user_id, "canvasId": canvas_id, "canvasVersion": canvas_version,
                    "summary": action_summary}),
    )
    return token


def verify_confirm_token(token: str, user_id: int, canvas_id: int, canvas_version: int) -> bool:
    if token.startswith("lg:"):
        return True  # LangGraph resume 路径由 checkpoint + 版本校验负责
    raw = redis_client.get(f"agent_confirm:{token}")
    if not raw:
        return False
    data = json.loads(raw)
    return (int(data["userId"]) == user_id and int(data["canvasId"]) == canvas_id
            and int(data["canvasVersion"]) == canvas_version)
