"""生成终态回写画布节点 status/execStatus + Agent resume。"""

from types import SimpleNamespace

from generation.services.task_service import TaskService


def test_notify_canvas_writes_succeeded_exec_status(monkeypatch):
    calls = []
    posts = []

    def fake_put(url, headers=None, json=None, timeout=None, trust_env=None):
        calls.append({"url": url, "json": json, "headers": headers})

        class R:
            status_code = 200

            def raise_for_status(self):
                return None

        return R()

    def fake_post(url, json=None, timeout=None, trust_env=None):
        posts.append({"url": url, "json": json})

        class R:
            status_code = 200

        return R()

    def fake_get(url, headers=None, timeout=None, trust_env=None):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"canvas": {"version": 1}},
        )

    monkeypatch.setattr("generation.services.task_service.httpx.put", fake_put)
    monkeypatch.setattr("generation.services.task_service.httpx.get", fake_get)
    monkeypatch.setattr("generation.services.task_service.httpx.post", fake_post)
    task = SimpleNamespace(
        id=99, canvas_id=11, node_id=22, user_id=33, source="agent",
        error_code=None, model_type="image",
    )
    out = SimpleNamespace(url="http://x/a.png", meta={})
    TaskService().notify_canvas_node(task, "succeeded", [out])
    assert calls
    body = calls[0]["json"]
    assert body["status"] == "succeeded"
    assert body["execStatus"] == "succeeded"
    assert "params" not in body
    assert body["output"]["url"] == "http://x/a.png"
    assert calls[0]["headers"]["X-User-Id"] == "33"
    assert "/canvases/11/nodes/22" in calls[0]["url"]
    assert posts and "/internal/agent/resume" in posts[0]["url"]


def test_notify_canvas_skips_without_ids(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "generation.services.task_service.httpx.put",
        lambda *a, **k: calls.append(1),
    )
    monkeypatch.setattr(
        "generation.services.task_service.httpx.post",
        lambda *a, **k: calls.append(2),
    )
    TaskService().notify_canvas_node(SimpleNamespace(canvas_id=None, node_id=1, user_id=1), "succeeded")
    assert calls == []


def test_notify_agent_resume_on_terminal(monkeypatch):
    posts = []

    class FakeResp:
        status_code = 200

        def json(self):
            return {"canvas": {"version": 1}}

        def raise_for_status(self):
            return None

    def fake_post(url, json=None, timeout=None, trust_env=None):
        posts.append({"url": url, "json": json})
        return FakeResp()

    monkeypatch.setattr("generation.services.task_service.httpx.post", fake_post)
    monkeypatch.setattr("generation.services.task_service.httpx.put", lambda *a, **k: FakeResp())
    monkeypatch.setattr("generation.services.task_service.httpx.get", lambda *a, **k: FakeResp())
    task = SimpleNamespace(
        id=55, canvas_id=1, node_id=2, user_id=3, source="agent",
        error_code=None, model_type="image",
    )
    TaskService().notify_canvas_node(task, "succeeded", [])
    assert posts
    assert "/internal/agent/resume" in posts[0]["url"]
    assert posts[0]["json"]["status"] == "succeeded"

    posts.clear()
    TaskService().notify_canvas_node(task, "running", [])
    assert posts == []


def test_notify_agent_resume_retries_transient_agent_failure(monkeypatch):
    attempts = []

    class FakeResp:
        def __init__(self, status_code):
            self.status_code = status_code

    def fake_post(*args, **kwargs):
        attempts.append(1)
        return FakeResp(503 if len(attempts) == 1 else 200)

    monkeypatch.setattr("generation.services.task_service.httpx.post", fake_post)
    monkeypatch.setattr("generation.services.task_service.time.sleep", lambda *_: None)
    task = SimpleNamespace(
        id=56, canvas_id=1, node_id=2, user_id=3, source="agent",
        error_code=None, model_type="image",
    )

    TaskService().notify_agent_resume(task, "succeeded", [])

    assert len(attempts) == 2


def test_notify_canvas_reads_version_and_sends_required_update_contract(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200

        def json(self):
            return {"canvas": {"version": 17}}

        def raise_for_status(self):
            return None

    def fake_get(url, headers=None, timeout=None, trust_env=None):
        calls.append(("get", url, headers, timeout, trust_env))
        return FakeResp()

    def fake_put(url, headers=None, json=None, timeout=None, trust_env=None):
        calls.append(("put", url, headers, json, timeout, trust_env))
        return FakeResp()

    monkeypatch.setattr("generation.services.task_service.httpx.get", fake_get)
    monkeypatch.setattr("generation.services.task_service.httpx.put", fake_put)
    monkeypatch.setattr(
        "generation.services.task_service.httpx.post",
        lambda *a, **k: FakeResp(),
    )

    task = SimpleNamespace(
        id=101, canvas_id=11, node_id=22, user_id=33, source="agent",
        error_code=None, model_type="image",
    )
    TaskService().notify_canvas_node(task, "succeeded", [])

    assert calls[0][0] == "get"
    put = calls[1]
    assert put[0] == "put"
    assert put[2]["Idempotency-Key"] == "generation-terminal:101:succeeded"
    assert put[3]["expectedVersion"] == 17


def test_notify_canvas_retries_after_optimistic_lock_conflict(monkeypatch):
    calls = []
    versions = iter([17, 18])
    put_attempts = iter([409, 200])

    class FakeResp:
        def __init__(self, status_code):
            self.status_code = status_code

        def json(self):
            return {"canvas": {"version": next(versions)}}

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

    def fake_get(url, headers=None, timeout=None, trust_env=None):
        calls.append(("get", url))
        return FakeResp(200)

    def fake_put(url, headers=None, json=None, timeout=None, trust_env=None):
        status_code = next(put_attempts)
        calls.append(("put", json["expectedVersion"]))
        return FakeResp(status_code)

    monkeypatch.setattr("generation.services.task_service.httpx.get", fake_get)
    monkeypatch.setattr("generation.services.task_service.httpx.put", fake_put)
    monkeypatch.setattr(
        "generation.services.task_service.httpx.post",
        lambda *a, **k: FakeResp(200),
    )

    task = SimpleNamespace(
        id=102, canvas_id=11, node_id=22, user_id=33, source="agent",
        error_code=None, model_type="image",
    )
    TaskService().notify_canvas_node(task, "succeeded", [])

    assert calls == [("get", "http://localhost:8082/api/v1/canvases/11"),
                     ("put", 17),
                     ("get", "http://localhost:8082/api/v1/canvases/11"),
                     ("put", 18)]
