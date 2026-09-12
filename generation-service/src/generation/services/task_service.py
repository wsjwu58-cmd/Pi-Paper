"""生成任务服务：状态机流转、执行、历史、估价。"""

import json
import itertools
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import redis
from sqlalchemy.orm import Session

from ..core.config import settings
from ..domain.task_states import TaskStateError, transition
from ..models import GenerationTask, ModelConfig, PricingRule, TaskAttempt, TaskOutput
from ..providers.providers import GenerationRequest, get_provider
from .agent_terminal_callback import build_agent_terminal_callback
from .model_resolve import resolve_model_config

redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True, protocol=2)
_id_seq = itertools.count(1)
_SNOWFLAKE_EPOCH_MS = 1735689600000  # 对齐 Java SnowflakeIdGenerator


def next_id() -> int:
    """生成落在 signed bigint 内的类 Snowflake ID（避免旧实现左移溢出）。"""
    ts = max(0, int(time.time() * 1000) - _SNOWFLAKE_EPOCH_MS)
    return (ts << 22) | (next(_id_seq) & 0x3FFFFF)


def publish_event(task_id, event: dict):
    try:
        redis_client.publish(f"task:{task_id}", json.dumps(event, ensure_ascii=False, default=str))
    except Exception:
        pass


class TaskService:
    def replay_recent_agent_terminals(self, db: Session, limit: int = 20) -> None:
        """补发刚完成的 Agent 任务终态；Agent 端会按 task_id 幂等去重。"""
        terminal_statuses = ("succeeded", "failed", "cancelled", "expired", "settlement_error")
        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        tasks = (
            db.query(GenerationTask)
            .filter(
                GenerationTask.source == "agent",
                GenerationTask.status.in_(terminal_statuses),
                GenerationTask.finished_at >= cutoff,
            )
            .order_by(GenerationTask.finished_at.desc())
            .limit(limit)
            .all()
        )
        for task in tasks:
            self.notify_agent_resume(task, task.status, self.get_outputs(db, task.id))

    def estimate(self, db: Session, model_type: str, model_params: dict, count: int = 1) -> dict:
        requested = (model_type or "").strip()
        exact = resolve_model_config(db, requested)
        if exact and exact.enabled:
            models = [exact]
        else:
            models = db.query(ModelConfig).filter(
                ModelConfig.model_type == requested, ModelConfig.enabled == True  # noqa: E712
            ).all()
        if not models:
            return {"estimatedCost": None, "models": []}
        results = []
        for m in models:
            cost = m.base_price
            rules = db.query(PricingRule).filter(PricingRule.model_id == m.id).all()
            for rule in rules:
                value = model_params.get(rule.rule_key)
                if value is not None and str(value) == rule.rule_value:
                    cost = rule.points
                    break
            resolution = str(model_params.get("resolution", "")).lower()
            if resolution and "x" in resolution:
                w, h = (int(x) for x in resolution.split("x"))
                pixels = w * h
                if pixels >= 1920 * 1080:
                    cost += 5
            total = max(1, cost * max(1, count))
            results.append({"modelId": m.id, "name": m.name, "displayName": m.display_name,
                            "estimatedCost": total, "basePrice": m.base_price})
        return {"models": results}

    def create_task(self, db: Session, payload: dict) -> dict:
        task_id = int(payload["taskId"])
        existing = db.get(GenerationTask, task_id)
        if existing:
            return self.to_dict(existing)
        task = GenerationTask(
            id=task_id,
            user_id=int(payload.get("userId", 0)),
            node_id=payload.get("nodeId"),
            canvas_id=payload.get("canvasId"),
            model_type=payload.get("modelType", "text"),
            model_params=payload.get("modelParams") or {},
            estimated_cost=int(payload.get("estimatedCost", 0)),
            status="queued",
            source=payload.get("source", "user"),
            pricing_version=1,
            freeze_deadline=datetime.now(timezone.utc) + timedelta(minutes=settings.freeze_ttl_minutes),
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "queued"})
        self.dispatch(db, task_id)
        return self.to_dict(task)

    def dispatch(self, db: Session, task_id: int):
        """按配置分发到 Celery 或内联线程执行。"""
        if settings.task_executor == "celery":
            try:
                from ..workers.celery_app import run_generation_task

                run_generation_task.delay(task_id)
                return
            except Exception:
                pass
        threading.Thread(target=self.execute_task, args=(task_id,), daemon=True).start()

    def execute_task(self, task_id: int):
        from ..core.db import SessionLocal

        db = SessionLocal()
        try:
            task = db.get(GenerationTask, task_id)
            if task is None or task.status not in ("queued", "running"):
                return
            task.status = transition(task.status, "running")
            task.started_at = datetime.now(timezone.utc)
            task.attempts += 1
            db.commit()
            publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "running"})
            self.notify_canvas_node(task, "running")

            from .model_resolve import resolve_model_config

            # model_type 可能是具体名（agnes-2.5-flash）或 modality 别名（text）
            model = resolve_model_config(db, task.model_type)
            provider_name = model.provider if model else "mock"
            modality = model.model_type if model else task.model_type
            model_name = model.name if model else task.model_type
            provider = get_provider(provider_name, modality)
            attempt = TaskAttempt(
                id=next_id(),
                task_id=task_id,
                attempt_no=task.attempts,
                provider=provider.name,
                status="running",
                started_at=datetime.now(timezone.utc),
            )
            db.add(attempt)
            db.commit()

            request = GenerationRequest(
                task_id=task_id,
                model_type=modality,
                model_name=model_name,
                params=task.model_params or {},
                output_dir=f"{settings.storage_dir}/{task_id}",
            )
            job = provider.generate(request)
            if job.status == "succeeded":
                task.status = "succeeded"
                task.actual_cost = task.estimated_cost
                task.finished_at = datetime.now(timezone.utc)
                task.updated_at = datetime.now(timezone.utc)
                db.add(task)
                outputs = []
                for o in job.result.get("outputs", []):
                    meta = o.get("meta", {}) or {}
                    content_type = o.get("content_type") or ""
                    inferred = meta.get("outputType")
                    if not inferred:
                        if content_type.startswith("image"):
                            inferred = "image"
                        elif content_type.startswith("video"):
                            inferred = "video"
                        elif content_type.startswith("audio"):
                            inferred = "audio"
                        elif modality in {"text", "image", "video", "audio", "compose", "director"}:
                            inferred = (
                                "video"
                                if modality == "compose"
                                else "image"
                                if modality == "director"
                                else modality
                            )
                        else:
                            inferred = "text"
                    out = TaskOutput(
                        id=next_id(),
                        task_id=task_id,
                        output_type=inferred,
                        url=o.get("url"),
                        content_type=content_type,
                        file_path=o.get("file_path"),
                        meta=meta,
                        created_at=datetime.now(timezone.utc),
                    )
                    db.add(out)
                    outputs.append(out)
                attempt.status = "succeeded"
                attempt.finished_at = datetime.now(timezone.utc)
                db.commit()
                publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "succeeded",
                                        "actualCost": task.actual_cost, "outputCount": len(outputs)})
                self.notify_canvas_node(task, "succeeded", outputs)
                self.notify_billing(task_id, "settle", {
                    "taskId": task_id, "actualCost": task.actual_cost, "modelType": task.model_type})
                self.notify_identity_progress(task.user_id)
                self.notify_analytics("task_generate_success", {
                    "task_id": task_id, "model_type": task.model_type,
                    "process_time": int((task.finished_at - task.started_at).total_seconds() * 1000),
                    "actual_cost": task.actual_cost, "output_count": len(outputs)})
            else:
                task.status = "failed"
                task.error_code = job.error_code or "MODEL_UNAVAILABLE"
                task.error_message = job.error_message or "生成结果无效"
                task.retryable = True
                task.finished_at = datetime.now(timezone.utc)
                attempt.status = "failed"
                attempt.error_code = task.error_code
                attempt.error_message = task.error_message
                attempt.finished_at = datetime.now(timezone.utc)
                db.commit()
                publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "failed",
                                        "errorCode": task.error_code, "errorMessage": task.error_message})
                self.notify_canvas_node(task, "failed")
                self.notify_billing(task_id, "fail", {
                    "taskId": task_id, "errorCode": task.error_code})
                self.notify_analytics("task_generate_fail", {
                    "task_id": task_id, "model_type": task.model_type,
                    "error_code": task.error_code,
                    "process_time": int((task.finished_at - task.started_at).total_seconds() * 1000),
                    "points_unfrozen": task.estimated_cost})
        except TaskStateError as e:
            db.rollback()
            print(f"task {task_id} state error: {e}")
        except Exception as e:
            db.rollback()
            task = db.get(GenerationTask, task_id)
            if task and task.status in ("queued", "running"):
                task.status = "failed"
                task.error_code = "MODEL_UNAVAILABLE"
                task.error_message = str(e)[:500]
                task.retryable = True
                task.finished_at = datetime.now(timezone.utc)
                db.commit()
                publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "failed",
                                        "errorCode": task.error_code, "errorMessage": task.error_message})
                self.notify_billing(task_id, "fail", {"taskId": task_id, "errorCode": task.error_code})
                self.notify_canvas_node(task, "failed")
        finally:
            db.close()

    def cancel(self, db: Session, task_id: int, reason: str = "user_cancel"):
        task = db.get(GenerationTask, task_id)
        if task is None:
            return {"status": "not_found"}
        if task.status in ("queued", "running"):
            task.status = "cancelled"
            task.error_message = reason
            task.finished_at = datetime.now(timezone.utc)
            task.updated_at = datetime.now(timezone.utc)
            db.commit()
            publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "cancelled"})
            self.notify_canvas_node(task, "cancelled")
            self.notify_analytics("task_generate_cancel", {
                "task_id": task_id, "from_status": "queued" if task.status == "cancelled" else "running",
                "points_unfrozen": task.estimated_cost})
        return self.to_dict(task)

    def expire(self, db: Session, task_id: int):
        task = db.get(GenerationTask, task_id)
        if task is None or task.status != "queued":
            return None
        task.status = "expired"
        task.error_code = "FREEZE_EXPIRED"
        task.error_message = "任务排队超时，点数已退回"
        task.finished_at = datetime.now(timezone.utc)
        task.updated_at = datetime.now(timezone.utc)
        db.commit()
        publish_event(task_id, {"type": "task_status", "taskId": task_id, "status": "expired"})
        self.notify_canvas_node(task, "expired")
        return self.to_dict(task)

    def list_tasks(self, db: Session, user_id: int, keyword: Optional[str] = None, model: Optional[str] = None,
                   task_type: Optional[str] = None, status: Optional[str] = None,
                   canvas_id: Optional[int] = None, node_id: Optional[int] = None,
                   date_from: Optional[str] = None, date_to: Optional[str] = None,
                   page: int = 1, page_size: int = 20) -> dict:
        q = db.query(GenerationTask).filter(GenerationTask.user_id == user_id)
        if keyword:
            q = q.filter(GenerationTask.model_params["prompt"].astext.ilike(f"%{keyword}%"))
        if model:
            q = q.filter(GenerationTask.model_type == model)
        if task_type:
            q = q.filter(GenerationTask.model_type == task_type)
        if status:
            q = q.filter(GenerationTask.status == status)
        if canvas_id:
            q = q.filter(GenerationTask.canvas_id == canvas_id)
        if node_id:
            q = q.filter(GenerationTask.node_id == node_id)
        if date_from:
            q = q.filter(GenerationTask.created_at >= datetime.fromisoformat(date_from))
        if date_to:
            q = q.filter(GenerationTask.created_at <= datetime.fromisoformat(date_to))
        total = q.count()
        tasks = q.order_by(GenerationTask.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
        return {"items": [self.to_dict(t, db) for t in tasks], "total": total, "page": page, "pageSize": page_size}

    def get_task(self, db: Session, task_id: int) -> Optional[dict]:
        task = db.get(GenerationTask, task_id)
        return self.to_dict(task, db) if task else None

    def get_outputs(self, db: Session, task_id: int):
        return db.query(TaskOutput).filter(TaskOutput.task_id == task_id).order_by(TaskOutput.id).all()

    def to_dict(self, task: GenerationTask, db: Session | None = None) -> dict:
        data = {
            "taskId": task.id,
            "userId": task.user_id,
            "nodeId": task.node_id,
            "canvasId": task.canvas_id,
            "modelType": task.model_type,
            "modelParams": task.model_params,
            "estimatedCost": task.estimated_cost,
            "actualCost": task.actual_cost,
            "status": task.status,
            "errorCode": task.error_code,
            "errorMessage": task.error_message,
            "retryable": task.retryable,
            "source": task.source,
            "prompt": (task.model_params or {}).get("prompt", ""),
            "createdAt": task.created_at.isoformat() if task.created_at else None,
            "updatedAt": task.updated_at.isoformat() if task.updated_at else None,
            "outputs": [],
        }
        if db is not None:
            outs = self.get_outputs(db, task.id)
            data["outputs"] = [
                {
                    "id": o.id,
                    "outputType": o.output_type,
                    "url": o.url,
                    "contentType": o.content_type,
                    "meta": o.meta,
                }
                for o in outs
            ]
        return data

    def notify_canvas_node(self, task: GenerationTask, status: str, outputs: list | None = None) -> None:
        """生成终态回写画布 status/execStatus，避免 UI 已成功、Agent 摘要仍是 running。"""
        canvas_id = task.canvas_id
        node_id = task.node_id
        user_id = task.user_id
        if not canvas_id or not node_id or not user_id:
            return
        node_status = "succeeded" if status in ("succeeded", "settlement_error") else status
        body: dict = {"status": node_status, "execStatus": node_status, "stale": False}
        if node_status == "succeeded" and outputs:
            first = outputs[0]
            url = getattr(first, "url", None) if not isinstance(first, dict) else first.get("url")
            meta = getattr(first, "meta", None) if not isinstance(first, dict) else first.get("meta")
            if not isinstance(meta, dict):
                meta = {}
            text = str(meta.get("text") or meta.get("content") or "").strip() or None
            output: dict = {}
            if isinstance(url, str) and url.strip():
                output["url"] = url.strip()
            if text:
                output.update({"text": text, "content": text})
            if output:
                body["output"] = output
        try:
            headers = {
                "X-User-Id": str(user_id),
                "X-User-Role": "user",
                "Content-Type": "application/json",
                "Idempotency-Key": f"generation-terminal:{task.id}:{status}",
            }
            canvas_url = f"{settings.canvas_base_url}/api/v1/canvases/{canvas_id}"
            # Reading the version and writing the node is a TOCTOU pair. Batch
            # completions can race each other, so a single 409 must not drop a
            # terminal node update; re-read the authoritative version and retry
            # with the same idempotency key.
            for attempt in range(5):
                current = httpx.get(canvas_url, headers=headers, timeout=5, trust_env=False)
                current.raise_for_status()
                current_body = current.json()
                canvas = current_body.get("canvas") if isinstance(current_body, dict) else None
                version = canvas.get("version") if isinstance(canvas, dict) else None
                if isinstance(version, int):
                    body["expectedVersion"] = version
                response = httpx.put(
                    f"{canvas_url}/nodes/{node_id}",
                    headers=headers,
                    json=body,
                    timeout=5,
                    trust_env=False,
                )
                if response.status_code == 409 and attempt < 4:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                response.raise_for_status()
                break
        except Exception as e:
            print(f"[warn] notify canvas failed: {e}")
        # 终态事件唤醒 Agent（主路径）；clock 仅作长延迟兜底
        if status in ("succeeded", "failed", "cancelled", "expired", "settlement_error"):
            self.notify_agent_resume(task, status, outputs)

    def notify_agent_resume(self, task: GenerationTask, status: str, outputs: list | None = None) -> None:
        """HTTP 回调 agent-service：generation_terminal → resume。"""
        if status not in ("succeeded", "failed", "cancelled", "expired", "settlement_error"):
            return
        request = build_agent_terminal_callback(
            settings.agent_base_url,
            task,
            status,
            settings.environment,
            settings.internal_service_token,
            outputs,
        )
        if request is None:
            return
        last_error: Exception | None = None
        # The callback is idempotent on task_id + terminal status. A short retry
        # window prevents a transient Agent restart from silently dropping the
        # only signal that updates the chat and launches the continuation.
        for attempt in range(3):
            try:
                if request["headers"]:
                    response = httpx.post(**request, timeout=8, trust_env=False)
                else:
                    response = httpx.post(request["url"], json=request["json"], timeout=8, trust_env=False)
                if 200 <= response.status_code < 300:
                    return
                if 400 <= response.status_code < 500:
                    raise RuntimeError(f"AGENT_CALLBACK_FAILED:{response.status_code}")
                last_error = RuntimeError(f"AGENT_CALLBACK_FAILED:{response.status_code}")
            except Exception as error:
                last_error = error
                # Authentication and validation errors cannot recover by retrying.
                if "AGENT_CALLBACK_FAILED:4" in str(error):
                    break
            if attempt < 2:
                time.sleep(0.25 * (attempt + 1))
        if last_error is None:
            return
        if settings.environment in {"production", "staging"}:
            raise last_error
        print(f"[warn] notify agent resume failed after retries: {last_error}")

    def notify_billing(self, task_id, action, payload):
        try:
            if action == "settle":
                url = f"{settings.billing_base_url}/internal/tasks/{task_id}/settle"
            else:
                url = f"{settings.billing_base_url}/internal/tasks/{task_id}/fail"
            httpx.post(url, json=payload, timeout=5, trust_env=False)
        except Exception as e:
            print(f"[warn] notify billing failed: {e}")

    def notify_identity_progress(self, user_id):
        try:
            httpx.post(f"{settings.identity_base_url}/internal/users/{user_id}/daily-task-progress",
                       json={"taskKey": "task_generate", "delta": 1}, timeout=5, trust_env=False)
        except Exception:
            pass

    def notify_analytics(self, event_name, payload):
        try:
            httpx.post(f"{settings.admin_base_url}/internal/analytics-events",
                       json={"eventName": event_name, "payload": payload}, timeout=5, trust_env=False)
        except Exception:
            pass


task_service = TaskService()
