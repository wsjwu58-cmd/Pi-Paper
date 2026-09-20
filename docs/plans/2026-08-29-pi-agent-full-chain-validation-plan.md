# Pi Agent 全链路工程能力验收与补强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Before production code changes use `superpowers:test-driven-development`; for observed defects use `superpowers:systematic-debugging`; before completion claims use `superpowers:verification-before-completion`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重复执行的 Pi Agent 多轮全链路评测，补齐所有文本、图片、视频、音频、合成、派生、导演台和创作 Skill 能力；短剧以 Agent 按用户要求和 Skill 在画布编排完整生产工作流并真实生成完整单集成片为硬门槛。

**Architecture:** 采用四层验收：供应商/媒体合同测试、Agent 工具与状态测试、公开 API/SSE 多轮评测、真实浏览器画布验收。评测用例只通过公开业务入口准备和执行数据；每个缺陷先形成失败测试，修复后再运行浏览器场景与媒体探针。

**Tech Stack:** Node.js 22.19+、TypeScript、Fastify、Pi Agent Core、Vitest、Python 3.12、FastAPI、pytest、Java 21、Spring Boot、PostgreSQL、Redis、RocketMQ、Nacos、React、Vite、agent-browser、FFmpeg/ffprobe、Pillow、Windows SAPI。

**Spec:** `docs/specs/2026-08-29-pi-agent-full-chain-validation-design.md`

## Global Constraints

- Agent/文本模型固定为 `agnes-2.5-flash`。
- 图片模型固定为 `agnes-image-2.5-flash`；参考图放在 `extra_body.image`，本地素材与 Data URI 在请求前转换为纯 Base64（不携带 `data:image/...;base64,` 前缀）。
- 视频模型固定为 `agnes-video-2.5-flash`；`size="720P"`，`seconds="4"` 至 `"12"`，参考图最多 5 张。
- 开发 E2E 的 TTS 使用本机 Windows SAPI，不产生 API 费用；豆包 TTS 生产接口继续保留。
- 所有生成任务保持确认、点数冻结、终态结算、Canvas 乐观锁和幂等约束。
- 不修改 `pi-main/packages/agent`、`pi-main/packages/ai` 或 `pi-main/packages/coding-agent`。
- 不回滚、清理或覆盖当前工作树已有修改；只编辑本计划列出的文件。
- Agnes Key 只保存在 Git 忽略的 `.env`；不得出现在源码、命令参数、日志、fixture、截图或文档。
- 本仓库 `pi-main/AGENTS.md` 禁止未获用户授权的提交；每个任务只记录 diff 检查点，不自动 commit。
- 每项能力必须覆盖正常、边界、失败、恢复/重试和幂等；模型视觉质量另做人工评分，不能替代工程断言。
- 每轮评测记录 `request_id → session_id → run_id → action_id/task_id → node_id`。
- 短剧真实验收不得以三镜头纵切代替完整成果：至少生成约 60 秒、9:16、15 个 4 秒镜头的可播放成片，包含角色参考、关键帧、视频、TTS、字幕和 Compose。

---

## 文件结构

### 新增

- `pi-main/packages/vibepaper-agent-service/src/domain/generation-intent.ts`：统一多模态生成、派生和导演台意图类型及服务端校验。
- `pi-main/packages/vibepaper-agent-service/src/tools/media-tools.ts`：Agent 可调用的派生、合成、导演台工具。
- `pi-main/packages/vibepaper-agent-service/test/generation-intent.test.ts`：意图矩阵与边界测试。
- `pi-main/packages/vibepaper-agent-service/test/media-tools.test.ts`：派生、合成、导演台工具合同测试。
- `pi-main/packages/vibepaper-agent-service/evals/eval-schema.ts`：多轮用例和断言 Schema。
- `pi-main/packages/vibepaper-agent-service/evals/eval-client.ts`：公开 Agent API、确认和 SSE 客户端。
- `pi-main/packages/vibepaper-agent-service/evals/evidence-writer.ts`：脱敏证据写入。
- `pi-main/packages/vibepaper-agent-service/evals/media-probe.ts`：图片、视频、音频探针。
- `pi-main/packages/vibepaper-agent-service/evals/run-evals.ts`：真实多轮评测入口，替换现有 JSON loader。
- `pi-main/packages/vibepaper-agent-service/test/eval-schema.test.ts`：用例完整性和覆盖矩阵测试。
- `pi-main/packages/vibepaper-agent-service/test/eval-runner.test.ts`：SSE、确认、重连、证据测试。
- `generation-service/tests/test_agnes_free_model_contracts.py`：三个 Agnes 模型的请求和响应合同。
- `generation-service/tests/test_local_sapi_tts.py`：离线 TTS 合同测试。
- `generation-service/tests/test_media_processing_matrix.py`：剪辑、抽帧、超分、扩图、音轨和合成矩阵。
- `vibepaper-web/src/features/canvas/director/directorCaptureBridge.ts`：Agent 请求与 Three.js 捕获之间的前端桥接。
- `vibepaper-web/src/features/canvas/director/directorCaptureBridge.test.ts`：导演台捕获状态机测试。
- `deploy/verify-all.ps1`：全栈启动前置与健康检查。
- `deploy/tests/verify-all.tests.ps1`：不启动付费任务的脚本级回归。
- `scripts/e2e/run-agent-browser-evals.ps1`：浏览器多轮执行与截图入口。
- `scripts/e2e/check-evidence.ps1`：证据目录完整性检查。
- `docs/evals/pi-agent-full-chain-coverage-matrix.md`：实际执行状态与证据链接。
- `docs/evals/pi-agent-full-chain-implementation-report.md`：修复、命令、结果与残余风险。

### 修改

- `generation-service/src/generation/core/config.py`：免费模型与本地 TTS 配置。
- `generation-service/src/generation/providers/providers.py`：Agnes 2.5 Flash、SAPI 和媒体派生实现。
- `generation-service/src/generation/services/model_service.py`：模型目录与参数默认值。
- `generation-service/src/generation/services/task_service.py`：媒体输入、lineage、终态和错误映射。
- `pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts`：新增受控媒体与导演台工具。
- `pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts`：明确 Schema 和工具执行器。
- `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`：支持所有节点类型、派生和顺序输入。
- `pi-main/packages/vibepaper-agent-service/src/pi/profile-agents.ts`：按 profile 暴露工具并限制只读审校。
- `pi-main/packages/vibepaper-agent-service/src/api/app.ts`：评测需要的恢复/确认合同与导演台动作事件。
- `skills/skills.md`：补齐商业视觉、实景纸刊和界面设计 Skill。
- `pi-main/packages/vibepaper-agent-service/src/domain/skill-manifest.generated.ts`：由生成脚本更新，不手工编辑。
- `vibepaper-web/src/features/canvas/AgentPanel.tsx`：多轮状态、确认、前端动作与错误展示。
- `vibepaper-web/src/features/canvas/director/DirectorStageEditor.tsx`：接收 Agent 配置并完成捕获回写。
- `vibepaper-web/src/features/canvas/nodes/NodeEditorPanel.tsx`：统一供应商参数和派生结果显示。
- `deploy/start-all.ps1`：本地 `.env`、进程和健康检查。

---

### Task 1：冻结验收基线与安全启动

**Files:**
- Create: `deploy/verify-all.ps1`
- Create: `deploy/tests/verify-all.tests.ps1`
- Modify: `deploy/start-all.ps1`
- Local only: `pi-main/packages/vibepaper-agent-service/.env`

**Interfaces:**
- Produces: `Test-VibePaperPrerequisite -Name <string> -Probe <scriptblock>`；失败时退出码非零。
- Produces: 健康端点集合 `5173, 8080-8087, 8090, 8091` 和基础设施探针 `5432, 6379, 8848, 9876`。

- [x] **Step 1: 写启动脚本失败测试**

```powershell
$json = & "$PSScriptRoot\..\verify-all.ps1" -CheckOnly -Json
$result = $json | ConvertFrom-Json
if (-not ($result.checks.name -contains 'agent-env')) { throw 'agent-env check missing' }
if (-not ($result.checks.name -contains 'agnes-key')) { throw 'agnes-key check missing' }
if ($json -match 'sk-[A-Za-z0-9]') { throw 'secret leaked' }
```

- [x] **Step 2: 运行测试并确认当前失败**

Run: `pwsh -File deploy/tests/verify-all.tests.ps1`  
Expected: FAIL，原因是 `verify-all.ps1` 尚不存在。

- [x] **Step 3: 实现安全 preflight 与条件等待**

`verify-all.ps1` 输出只包含 `name/status/message`，不输出环境变量值；`start-all.ps1` 先运行 preflight，再启动进程，使用端口/health 条件等待，不使用固定长睡眠。

- [x] **Step 4: 创建本地 Agent 环境文件**

从 `.env.example` 创建被 Git 忽略的 `.env`，把用户提供的 Key 写入 `VIBEPAPER_LLM_API_KEY` 和 `VIBEPAPER_AGNES_API_KEY`，模型设为三个固定免费模型；生成随机本地确认签名密钥和内部服务令牌。命令和日志不得包含 Key 明文。

- [x] **Step 5: 运行脚本测试与泄密扫描**

Run: `pwsh -File deploy/tests/verify-all.tests.ps1`  
Run: `rg -n 'sk-[A-Za-z0-9]{20,}' . -g '!generation-service/.env' -g '!pi-main/packages/vibepaper-agent-service/.env' -g '!node_modules/**' -g '!.git/**'`  
Expected: 测试 PASS；泄密扫描没有新命中。

- [x] **Step 6: 记录检查点**

Run: `git diff --check -- deploy/start-all.ps1 deploy/verify-all.ps1 deploy/tests/verify-all.tests.ps1`

---

### Task 2：锁定 Agnes 三模型供应商合同

**Files:**
- Create: `generation-service/tests/test_agnes_free_model_contracts.py`
- Modify: `generation-service/src/generation/core/config.py`
- Modify: `generation-service/src/generation/providers/providers.py`
- Modify: `generation-service/src/generation/services/model_service.py`

**Interfaces:**
- Produces: `build_agnes_image_payload(params: dict) -> dict`
- Produces: `build_agnes_video_payload(params: dict) -> dict`
- Produces: `build_agnes_video_poll_url(video_id: str, model_name: str) -> str`

- [x] **Step 1: 写图片请求失败测试**

```python
def test_image_reference_is_nested_in_extra_body() -> None:
    payload = build_agnes_image_payload({
        "prompt": "保留瓶身，改成雨夜背景", "size": "2K", "ratio": "9:16",
        "referenceImages": ["https://cdn.test/bottle.png"],
    })
    assert payload == {
        "model": "agnes-image-2.5-flash", "prompt": "保留瓶身，改成雨夜背景",
        "size": "2K", "ratio": "9:16",
        "extra_body": {"image": ["https://cdn.test/bottle.png"], "response_format": "url"},
    }
```

- [x] **Step 2: 写视频模式参数化失败测试**

```python
@pytest.mark.parametrize(("params", "mode"), [
    ({"prompt": "雨夜街道", "duration": 5}, "text"),
    ({"prompt": "转身", "firstFrameUrl": "https://cdn/f.png"}, "keyframe"),
    ({"prompt": "参考角色", "referenceImages": ["https://cdn/r.png"]}, "reference"),
])
def test_video_mode_and_flash_limits(params: dict, mode: str) -> None:
    payload = build_agnes_video_payload(params)
    assert payload["model"] == "agnes-video-2.5-flash"
    assert payload["mode"] == mode
    assert payload["size"] == "720P"
    assert payload["seconds"] == "5"
    assert payload["n"] == 1
```

- [x] **Step 3: 写边界和失败测试**

覆盖 4/12 秒、3/13 秒、6 张参考图、reference 视频、无关键帧的 keyframe、无参考的 reference、非法画幅、429 退避、400 不重试、poll 必带 `model_name`、completed/failed/timeout 映射。

- [x] **Step 4: 运行测试并确认因旧 2.0 契约失败**

Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_agnes_free_model_contracts.py -q`  
Expected: FAIL，至少显示旧 `agnes-video-v2.0`、旧尺寸或旧轮询参数。

- [x] **Step 5: 最小实现三个纯函数并接入 Provider**

将供应商参数组装集中到纯函数；HTTP 层只负责认证、超时、重试和响应下载。禁止把 `response_format` 放到图片请求顶层。

- [x] **Step 6: 更新模型目录**

视频种子改为：

```python
("agnes-video-2.5-flash", "video", "Agnes Video 2.5 Flash", "720P 免费文生/关键帧/参考视频生成", "agnes-video", 35,
 {"size": "720P", "seconds": "5", "aspect_ratio": "16:9", "n": 1}, True)
```

旧视频别名可解析到 2.5 Flash，但模型目录只启用正式模型。

- [x] **Step 7: 运行定向与全量 Generation 测试**

Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_agnes_free_model_contracts.py tests/test_model_resolve.py tests/test_model_capability_and_fallback.py -q`  
Expected: PASS。

---

### Task 3：实现免费本地 SAPI TTS Provider

**Files:**
- Create: `generation-service/tests/test_local_sapi_tts.py`
- Modify: `generation-service/src/generation/core/config.py`
- Modify: `generation-service/src/generation/providers/providers.py`
- Modify: `generation-service/src/generation/services/model_service.py`

**Interfaces:**
- Produces: provider name `local-sapi-tts`
- Consumes params: `{text, voice, language, speed, tone, outputFormat}`
- Produces output meta: `{voiceId, language, rate, toneApplied, textHash, durationMs, sampleRate}`

- [x] **Step 1: 写可播放 WAV 失败测试**

```python
def test_sapi_generates_non_empty_wave(tmp_path: Path) -> None:
    job = WindowsSapiTtsProvider().generate(GenerationRequest(
        task_id=1, model_type="audio", model_name="local-sapi-tts",
        params={"text": "你好，VibePaper", "voice": "female", "speed": 0.95, "tone": "calm"},
        output_dir=str(tmp_path),
    ))
    assert job.status == "succeeded"
    output = job.result["outputs"][0]
    with wave.open(output["file_path"], "rb") as wav:
        assert wav.getnframes() > 0
        assert wav.getframerate() >= 16000
```

- [ ] **Step 2: 写参数与失败矩阵**

覆盖中文男/女声、英文女声、0.5/0.95/1.0/1.5/2.0 语速、空文本、超长文本、未知 voice、未知 tone、输出目录不可写、进程超时、文本哈希稳定、相同幂等键不重复生成。

- [ ] **Step 3: 运行并确认 Provider 不存在**

Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_local_sapi_tts.py -q`  
Expected: FAIL with import/provider error。

- [x] **Step 4: 实现 SAPI 调用与脱敏错误**

使用 `System.Speech.Synthesis.SpeechSynthesizer.SetOutputToWaveFile`；参数通过临时 JSON 文件或标准输入传递，不把正文和环境变量拼入 shell 命令。`tone` 只映射已验证的 rate/volume，无法表达的语气返回 `toneApplied=false` 和可见说明。

- [x] **Step 5: 启用本地模型条目**

增加 `local-sapi-tts` 音频模型并在 development 环境优先；生产仍优先 `doubao-tts` 且缺凭据时 fail-closed。

- [x] **Step 6: 验证**

Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_local_sapi_tts.py -q`  
Expected: PASS，生成文件可由 Python `wave` 打开。

---

### Task 4：补齐媒体派生和 Compose 的确定性合同

**Files:**
- Create: `generation-service/tests/test_media_processing_matrix.py`
- Modify: `generation-service/src/generation/providers/providers.py`
- Modify: `generation-service/src/generation/services/task_service.py`

**Interfaces:**
- Consumes operations: `clip_video`, `extract_frame`, `upscale_image`, `upscale_video`, `outpaint_image`, `strip_audio`, `mux_audio`, `compose_videos`
- Produces: 不可变派生输出和 `lineage: {sourceTaskIds, sourceNodeIds, operation, paramsHash}`

- [ ] **Step 1: 生成受控媒体 fixture**

测试内用 FFmpeg 生成 6 秒双色视频和 1 秒 WAV，固定 24fps、1280×720，避免依赖真实模型随机结果。

- [ ] **Step 2: 写剪辑/抽帧测试**

```python
@pytest.mark.parametrize(("start", "end", "expected"), [(0, 2, 2), (1, 4, 3), (5, 6, 1)])
def test_clip_preserves_source_and_duration(start: float, end: float, expected: float, media_fixture): ...

@pytest.mark.parametrize("timestamp", [0.0, 2.5, 5.95])
def test_extract_frame_returns_image_at_valid_timestamp(timestamp: float, media_fixture): ...
```

失败矩阵包含负时间、start=end、start>end、超出源时长、源文件不存在和损坏媒体。

- [ ] **Step 3: 写超分/扩图测试**

图片 1K→2K/4K、视频 720P→1080P、9:16→16:9 扩图、主体中心像素保留、非法倍数、尺寸上限和源文件不变。

- [ ] **Step 4: 写音轨与 Compose 测试**

覆盖 2/3/10 段顺序、零段/一段拒绝、分辨率不同规范化、无音轨、混合音轨、损坏片段、重复输入、幂等重放、输出总时长容差 ±0.2 秒。

- [ ] **Step 5: 运行并确认缺口**

Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_media_processing_matrix.py -q`  
Expected: FAIL 于未支持的 operation、lineage 或媒体边界。

- [ ] **Step 6: 实现最小操作分发**

所有 FFmpeg 参数用数组传入 `subprocess.run`；对输入路径做本地存储解析；输出文件名包含 operation；源文件只读；错误码固定为 `INVALID_INPUT`、`MEDIA_UNREADABLE`、`MODEL_TIMEOUT` 或 `MEDIA_PROCESSING_FAILED`。

- [ ] **Step 7: 验证**

Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_media_processing_matrix.py -q`  
Expected: PASS。

---

### Task 5：建立统一 GenerationIntent 和节点合同

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/generation-intent.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/generation-intent.test.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`

**Interfaces:**

```ts
export type GenerationIntent =
  | { kind: "text"; prompt: string; referenceNodeIds: string[] }
  | { kind: "image"; prompt: string; size: "1K"|"2K"|"3K"|"4K"; ratio: AspectRatio; referenceNodeIds: string[] }
  | { kind: "video"; prompt: string; seconds: 4|5|6|7|8|9|10|11|12; size: "720P"; aspectRatio: AspectRatio; mode: "text"|"keyframe"|"reference"; firstFrameNodeId?: string; lastFrameNodeId?: string; referenceNodeIds: string[]; withAudio: boolean }
  | { kind: "audio"; text?: string; textNodeId?: string; voice: string; language: string; speed: number; tone: string }
  | { kind: "compose"; videoNodeIds: string[] }
  | { kind: "derive"; operation: DeriveOperation; sourceNodeIds: string[]; params: Record<string, unknown> }
  | { kind: "director"; scene: DirectorSceneIntent };
```

- [x] **Step 1: 写参数化校验失败测试**

覆盖所有 union 分支、视频 3/13 秒、6 张参考图、keyframe 缺帧、compose 少于 2 段、audio 同时缺正文和文本节点、派生源类型错误、导演台未知模型和相机越界。

- [x] **Step 2: 运行并确认模块不存在**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/generation-intent.test.ts`  
Expected: FAIL with module not found。

- [x] **Step 3: 实现归一化和确定性节点映射**

```ts
export function compileIntent(intent: GenerationIntent): CompiledCanvasPlan {
  // returns node payloads, ordered edges, model type/params and required approvals
}
```

节点类型必须覆盖 `text|image|video|audio|compose|director`，不再由 `CanvasNodeRequest` 限制为 image/video。

- [x] **Step 4: 验证**

Run: 同 Step 2。  
Expected: PASS。

---

### Task 6：给 Pi Agent 增加明确的媒体与导演台工具

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/tools/media-tools.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/media-tools.test.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/pi/profile-agents.ts`

**Interfaces:**
- Produces tools: `create_generation_node`, `derive_media`, `compose_videos`, `configure_director_stage`, `capture_director_stage`
- Keeps tools: read tools、`create_nodes`、`connect_nodes`、`layout_nodes`、`update_node_config`、`delete_nodes`、`submit_generation`。

- [ ] **Step 1: 写 profile 白名单失败测试**

```ts
expect(profileToolNames("canvas-general")).toContain("derive_media");
expect(profileToolNames("vertical-short-drama")).toContain("compose_videos");
expect(profileToolNames("audit-readonly")).not.toContain("derive_media");
expect(profileToolNames("asset-assistant")).not.toContain("submit_generation");
```

- [ ] **Step 2: 写工具副作用测试**

对每个工具断言真实调用顺序：读取权威节点 → 校验类型/状态/Canvas 版本 → 创建派生节点 → 创建有序 Edge → 需要时产生确认 action。断言 `inputs_not_ready` 不提交任务、相同幂等键不重复节点、顺序 Compose 不按 ID 排序。

- [ ] **Step 3: 运行并确认工具缺失**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/media-tools.test.ts test/tool-manifest.test.ts`  
Expected: FAIL on missing tools。

- [ ] **Step 4: 最小实现并接入 runtime**

工具 Schema 禁止 `additionalProperties`；模型不能提交本地路径或任意外部 URL，只能引用当前用户可访问节点/素材；审校 profile 保持只读。

- [ ] **Step 5: 验证**

Run: 同 Step 3。  
Expected: PASS。

---

### Task 7：完善确认、任务恢复和多轮继续执行

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/generation-action-executor.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/multiturn-generation-resume.test.ts`

**Interfaces:**
- Consumes: `POST /api/v1/agent/sessions/:sessionId/messages`
- Consumes: `POST /api/v1/agent/sessions/:sessionId/confirmations/:actionId`
- Produces: 确认后相同 `runId` 或显式 successor run，事件序列单调，生成任务只提交一次。

- [ ] **Step 1: 写多轮确认失败测试**

场景：第一轮创建 Text；第二轮创建 Image 并等待确认；接受后提交；第三轮引用该 Image 创建 Video；拒绝时不提交；刷新后从 `afterSeq` 恢复。

- [ ] **Step 2: 写并发和失效测试**

覆盖双击确认、token 重放、过期、错误用户、错误 session、Canvas 版本变化、确认前取消、确认后供应商失败、queued 回写失败触发补偿。

- [ ] **Step 3: 运行并确认至少一个真实缺口**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/multiturn-generation-resume.test.ts test/approval-service.test.ts test/generation-action-executor.test.ts`  
Expected: FAIL at missing resume/idempotency behavior。

- [ ] **Step 4: 实现单一根因修复**

确认消费、状态迁移和任务提交围绕 `actionId`/`idempotencyKey` 持久化；不得用内存 Map 作为生产幂等来源。

- [ ] **Step 5: 验证**

Run: 同 Step 3。  
Expected: PASS，事件无重复、只产生一个 task。

---

### Task 8：补齐 3D 导演台 Agent→浏览器→素材闭环

**Files:**
- Create: `vibepaper-web/src/features/canvas/director/directorCaptureBridge.ts`
- Create: `vibepaper-web/src/features/canvas/director/directorCaptureBridge.test.ts`
- Modify: `vibepaper-web/src/features/canvas/director/DirectorStageEditor.tsx`
- Modify: `vibepaper-web/src/features/canvas/director/DirectorNodeView.tsx`
- Modify: `vibepaper-web/src/features/canvas/AgentPanel.tsx`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`

**Interfaces:**

```ts
export type DirectorCaptureCommand = {
  commandId: string; nodeId: string; canvasVersion: number;
  scene: DirectorSceneIntent; requestedAt: string;
};
export type DirectorCaptureResult = {
  commandId: string; assetId: string; imageNodeId: string; width: number; height: number;
};
```

- [ ] **Step 1: 写桥接状态机失败测试**

覆盖 idle→configuring→capturing→uploading→completed、重复 command、节点卸载恢复、Canvas 版本冲突、未知 modelId、非人物 pose、WebGL 捕获失败、上传失败、完成后创建 Image 引用 Edge。

- [ ] **Step 2: 运行并确认桥接模块缺失**

Run: `cd vibepaper-web; pnpm vitest --run src/features/canvas/director/directorCaptureBridge.test.ts`  
Expected: FAIL with module not found。

- [ ] **Step 3: 实现捕获桥接**

Agent 只写结构化场景和捕获命令；前端使用现有 Three.js Canvas 捕获 PNG、上传素材、创建 Image 节点并回写 command 终态。浏览器未打开时保持 `waiting_frontend`，不能宣称完成。

- [ ] **Step 4: 验证单元测试与类型**

Run: `cd vibepaper-web; pnpm vitest --run src/features/canvas/director/directorCaptureBridge.test.ts`  
Run: `cd vibepaper-web; pnpm exec tsc -b --pretty false`  
Expected: PASS。

---

### Task 9：补齐 21 个创作 Skill 及其可执行合同

**Files:**
- Modify: `skills/skills.md`
- Modify via generator: `pi-main/packages/vibepaper-agent-service/src/domain/skill-manifest.generated.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/skill-execution-contracts.test.ts`

**Interfaces:**
- Each skill provides: `{id, key, version, title, triggerExamples, requiredInputs, outputContract, executionPolicy}`
- `executionPolicy` is one of `text_only|text_then_generate|generate_required|audit_readonly`。

- [ ] **Step 1: 使用 `superpowers:writing-skills` 读取并校准 Skill 编写规则**

本步骤在实施时先完成，随后才能编辑 `skills/skills.md`。

- [ ] **Step 2: 写行为合同失败测试**

测试通过 `load_skill` 真实加载并断言结构化 metadata，不 grep Markdown。要求 21 个用户点名 Skill 均有唯一 trigger、输出合同和执行策略；审校 Skill 不含写工具；“要求出图”的 Skill 为 `generate_required`。

- [ ] **Step 3: 运行并确认缺少 7 个 Skill**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/skill-execution-contracts.test.ts`  
Expected: FAIL，缺少产品视觉、产品喷绘广告、反重力产品广告、电商经营、潮流视觉 PV、实景纸刊、界面设计。

- [ ] **Step 4: 增加缺失 Skill 并统一现有 Skill 合同**

每个生成型 Skill 明确“用户要求产物时必须创建节点并进入确认/任务链”；连续性审校保持只读；六格漫画默认单页 Image；电影感三联图默认三个独立 Image。

- [x] **Step 5: 重新生成 manifest 并验证**

Run: `cd pi-main; npm run generate:skills --workspace=@vibepaper/pi-agent-service`  
Run: 同 Step 3。  
Expected: PASS，21 个 Skill 全覆盖且 manifest 可重复生成无额外 diff。

---

### Task 10：建立真实多轮评测 Schema、客户端和证据写入

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/evals/eval-schema.ts`
- Create: `pi-main/packages/vibepaper-agent-service/evals/eval-client.ts`
- Create: `pi-main/packages/vibepaper-agent-service/evals/evidence-writer.ts`
- Create: `pi-main/packages/vibepaper-agent-service/evals/media-probe.ts`
- Replace: `pi-main/packages/vibepaper-agent-service/evals/run-evals.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/package.json`
- Create: `pi-main/packages/vibepaper-agent-service/test/eval-schema.test.ts`
- Create: `pi-main/packages/vibepaper-agent-service/test/eval-runner.test.ts`

**Interfaces:**

```ts
export type EvalCase = {
  caseId: string;
  profile: AgentProfile;
  turns: EvalTurn[];
  assertions: EvalAssertion[];
  browserCheckpoints: BrowserCheckpoint[];
};
export interface EvalClient {
  createFixture(caseId: string): Promise<EvalFixture>;
  sendTurn(fixture: EvalFixture, turn: EvalTurn): Promise<EvalTurnResult>;
  confirm(actionId: string, token: string, accept: boolean): Promise<void>;
  resumeEvents(sessionId: string, afterSeq: number): AsyncIterable<AgentEventEnvelope>;
}
```

- [x] **Step 1: 写 Schema 完整性失败测试**

断言每个 case 至少 2 轮；每个生成 case 有 confirmation、task、node、media 断言；每个失败 case 有 stable error code；每个 Skill 都映射到至少一个 case。

- [x] **Step 2: 写 fake-client runner 测试**

覆盖多轮顺序、自动/手动确认、拒绝、SSE cursor 重连、终态等待、超时、JSON/NDJSON 证据、Authorization 脱敏、同 case 重跑创建独立 fixture。

- [ ] **Step 3: 运行并确认现有 loader 不满足合同**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/eval-schema.test.ts test/eval-runner.test.ts`  
Expected: FAIL。

- [x] **Step 4: 实现 runner**

runner 不直接修改业务数据库；通过 Identity、Billing、Canvas 和 Agent 公开接口准备 fixture。媒体探针调用 `ffprobe` 和图片 metadata，只写脱敏结果。

在 package scripts 中增加：

```json
{"eval":"tsx evals/run-evals.ts"}
```

- [x] **Step 5: 验证**

Run: 同 Step 3。  
Expected: PASS。

---

### Task 11：编写核心多模态多轮用例

**Files:**
- Modify/Create: `pi-main/packages/vibepaper-agent-service/evals/cases/core-product-visual.json`
- Modify/Create: `pi-main/packages/vibepaper-agent-service/evals/cases/keyframe-compose.json`
- Modify/Create: `pi-main/packages/vibepaper-agent-service/evals/cases/tts-subtitle.json`
- Modify/Create: `pi-main/packages/vibepaper-agent-service/evals/cases/director-stage.json`
- Modify/Create: `pi-main/packages/vibepaper-agent-service/evals/cases/vertical-short-drama-full-episode.json`
- Test: `pi-main/packages/vibepaper-agent-service/test/eval-schema.test.ts`

**Interfaces:**
- Consumes: Task 10 `EvalCase`。
- Produces: 5 个场景、至少 32 轮自然语言、覆盖 Appendix A 和 Appendix D 的核心 case IDs。

- [ ] **Step 1: 写覆盖计数失败测试**

```ts
expect(coverage.modalities).toEqual(new Set(["text","image","video","audio","compose","director"]));
expect(coverage.operations).toEqual(expect.arrayContaining([
  "img2img","keyframe","clip_video","extract_frame","upscale_image","upscale_video","outpaint_image","mux_audio"
]));
expect(coverage.totalTurns).toBeGreaterThanOrEqual(32);
```

- [ ] **Step 2: 编写真实用户式 turns**

不使用工具名，不直接传 node ID；后续轮次使用“上一张”“第二镜”“刚才的文案”等自然指代，验证 Agent 通过权威上下文解析。

- [ ] **Step 3: 为每轮增加副作用断言**

文本断言内容和节点；图片断言 size/ratio/reference；视频断言 mode/seconds/audio；派生断言 source lineage；Compose 断言顺序；导演台断言 capture command/result。

短剧场景必须额外断言：故事圣经、至少 2 个角色、每个重复角色的批准 ReferencePack、完整 Episode/Scene、至少 15 条 ShotSpec、15 张已接受关键帧、15 段成功视频、逐镜 TTS/字幕、最终 9:16 成片和可读的左到右画布依赖图。只生成 3 镜预览时用例必须失败。

- [ ] **Step 4: 运行 Schema 验证**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/eval-schema.test.ts`  
Expected: PASS。

---

### Task 12：编写 21 个 Skill 的全面用例

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/skills-short-video-drama.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/skills-comic-character.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/skills-commercial-visual.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/skills-portrait-poster-ui.json`
- Test: `pi-main/packages/vibepaper-agent-service/test/eval-schema.test.ts`

**Interfaces:**
- Produces: 每个 Skill 至少一个正向多轮 case 和一个输入不足/安全边界断言。

- [ ] **Step 1: 写 Skill 覆盖失败测试**

断言 Appendix B 的 21 个 Skill ID 全部出现；每个 `generate_required` case 有真实 Image/Video 节点和确认断言；`audit_readonly` case 禁止所有写工具。

- [ ] **Step 2: 编写短视频/短剧用例**

覆盖 1–3 分钟规格、用户指定约 60 秒完整单集、钩子、无钩子修复、对白长度、长内容压缩、伏笔审校、跨集角色事实和局部重跑。完整单集使用 15 个 4 秒镜头，并要求 Agent 从自然语言开始完成故事圣经、角色参考、剧本、Scene/ShotSpec、关键帧审校、全部视频、TTS、字幕和最终 Compose；只返回脚本、提示词、空节点或三镜头样片均失败。

- [ ] **Step 3: 编写漫画/角色用例**

六格单页、显式拆六图、角色参考缺失拒绝、唯一参考自动挂载、多候选要求用户选择、Look revision 变更影响范围。

- [ ] **Step 4: 编写商业视觉用例**

产品视觉、喷绘、反重力、电商经营和潮流 PV 各验证一轮文本规划和一轮真实出图/视频；产品外形必须引用输入素材，禁止无依据改 Logo/结构。

- [ ] **Step 5: 编写人像/海报/纸刊/UI 用例**

覆盖人像身份保持、极简海报留白/色锚、电影海报标题、单图、三张独立三联图、纸刊实景、界面设计的可读布局；同时测试缺参考图和用户明确要求复刻时的分支。

- [ ] **Step 6: 运行 Schema 与 Skill 合同测试**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/eval-schema.test.ts test/skill-execution-contracts.test.ts`  
Expected: PASS。

---

### Task 13：编写安全、恢复、并发和故障注入用例

**Files:**
- Modify/Create: `pi-main/packages/vibepaper-agent-service/evals/cases/security-and-recovery.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/concurrency-and-idempotency.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/provider-failures.json`
- Create: `pi-main/packages/vibepaper-agent-service/test/eval-security-coverage.test.ts`

**Interfaces:**
- Produces: Appendix C 全部 case IDs 的自动断言。

- [ ] **Step 1: 写安全覆盖失败测试**

断言用例集包含越权、Prompt 注入、伪造节点 URL、工具白名单、确认重放、版本冲突、重复冻结、SSE 重连、任务取消、超时、重复回调和服务不可用。

- [ ] **Step 2: 编写故障注入方式**

使用测试代理或可控 fake provider 返回 400/401/429/500、malformed JSON、超时和 completed-without-url；不修改生产表伪造状态。

- [ ] **Step 3: 编写恢复断言**

每项故障都断言稳定错误码、run 终态、点数解冻、节点终态、可重试标志和重放行为；不存在“界面报错但后台仍 running”的悬挂状态。

- [ ] **Step 4: 运行覆盖测试**

Run: `cd pi-main/packages/vibepaper-agent-service; node ..\..\..\node_modules\vitest\dist\cli.js --run test/eval-security-coverage.test.ts`  
Expected: PASS。

---

### Task 14：建立浏览器多会话与截图自动化

**Files:**
- Create: `scripts/e2e/run-agent-browser-evals.ps1`
- Create: `scripts/e2e/check-evidence.ps1`
- Create: `scripts/e2e/tests/check-evidence.tests.ps1`

**Interfaces:**
- Consumes: eval result 中的 `browserCheckpoints`。
- Produces: `output/evals/<run-date>/<case-id>/screenshots/<turn>-<checkpoint>.png` 和 console/network 摘要。

- [x] **Step 1: 写证据检查失败测试**

```powershell
& "$PSScriptRoot\..\check-evidence.ps1" -Root $fixture
if ($LASTEXITCODE -eq 0) { throw 'missing screenshot should fail' }
```

测试还覆盖空白截图、零字节媒体、缺 events.ndjson、缺 media-probe、包含密钥格式和重复截图文件名。

- [x] **Step 2: 运行并确认检查器不存在**

Run: `pwsh -File scripts/e2e/tests/check-evidence.tests.ps1`  
Expected: FAIL。

- [ ] **Step 3: 实现 agent-browser 流程**

每次页面变化后重新 snapshot；使用两个隔离 session 测多会话；保存 headed 浏览器截图；在每个关键轮次采集 console 和 failed requests；等待具体文本、节点或任务终态，不使用固定长睡眠。

- [x] **Step 4: 实现证据检查器并验证**

Run: 同 Step 2。  
Expected: PASS。

---

### Task 15：启动全栈并执行低成本合同烟测

**Files:**
- Evidence only: `output/evals/2026-08-29/preflight/`
- Modify only if a defect is reproduced: 对应最小服务文件和回归测试。

**Interfaces:**
- Consumes: Tasks 1–14。
- Produces: 全服务 health、模型目录、注册信息和单轮文本 Agent trace。

- [x] **Step 1: 启动服务**

Run: `pwsh -File deploy/start-all.ps1`  
Run: `pwsh -File deploy/verify-all.ps1 -Wait -Json`  
Expected: 所有目标端口和 health 通过；模型目录只显示指定正式模型和本地 TTS/Compose/Director。

- [ ] **Step 2: 执行不生成媒体的 API smoke**

创建测试用户、点数账户、Canvas、Agent Session；发送两轮文本请求；断言 SSE、run、message、节点和 Canvas 版本。

- [ ] **Step 3: 执行每类一个真实最小 canary**

依次运行 1K 图片、4 秒 720P 视频、本地短句 TTS、2 段本地 Compose。每个 canary 单独确认，失败立即进入系统化调试，不继续扩大调用量。

- [x] **Step 4: 记录实际结果**

保存脱敏 API snapshot、events、媒体探针和浏览器截图；失败用例不得标记通过。

---

### Task 16：逐场景执行、修复和回归

**Files:**
- Modify: 仅触发缺陷的生产文件。
- Test: 每个缺陷对应的最小现有或新增测试。
- Evidence: `output/evals/2026-08-29/<case-id>/`

**Interfaces:**
- Consumes: Tasks 11–14 用例。
- Produces: 每个 case `passed|failed|blocked_external`，其中 `blocked_external` 不能计入通过率。

- [ ] **Step 1: 按 A→G 顺序运行**

顺序为商品视觉、关键帧 Compose、TTS 字幕、导演台、短剧完整单集、Skill 回归、安全恢复。短剧可以先运行三镜头诊断用例定位链路问题，但最终状态只由完整 15 镜成片用例决定，三镜头结果不能计入通过率。

- [ ] **Step 2: 每个失败执行四阶段调试**

记录错误、稳定复现、最近 diff、多服务边界输入/输出；比较同仓库可工作的相邻能力；形成单一根因假设；写失败测试；做一个最小修复。

- [ ] **Step 3: 每次修复执行三层回归**

1. 失败测试；2. 所属服务相关测试集；3. 原浏览器 case。三层都通过才更新 coverage matrix。

- [ ] **Step 4: 三次失败后停止叠加补丁**

若同一根因连续三次最小修复未通过，输出架构问题、证据和两个可选重构边界，等待用户决策。

---

### Task 17：全量验证与实现文档

**Files:**
- Create: `docs/evals/pi-agent-full-chain-coverage-matrix.md`
- Create: `docs/evals/pi-agent-full-chain-implementation-report.md`
- Modify: `docs/operations/pi-agent-runbook.md`
- Modify: `docs/releases/pi-agent-production-readiness.md`

**Interfaces:**
- Produces: 每项能力到 case、命令、节点、任务、截图和状态的映射。

- [ ] **Step 1: 运行全量服务级验证**

Run: `cd pi-main; npm run check`  
Run: `cd pi-main; bash ./test.sh` 或按 `pi-main/AGENTS.md` 使用具体 Vitest 命令排除真实 provider E2E  
Run: `cd generation-service; .\.venv\Scripts\python.exe -m pytest -q`  
Run: `cd vibepaper-services; mvn -s settings-project.xml test`  
Run: `cd vibepaper-web; pnpm test; pnpm exec tsc -b --pretty false; pnpm build`  
Expected: 所有命令 exit 0；警告逐条记录，不笼统忽略。

- [ ] **Step 2: 运行全部多轮 API 和浏览器用例**

Run: `cd pi-main; npm run eval --workspace=@vibepaper/pi-agent-service -- packages/vibepaper-agent-service/evals/cases/*.json`  
Run: `pwsh -File scripts/e2e/run-agent-browser-evals.ps1`  
Run: `pwsh -File scripts/e2e/check-evidence.ps1 -Root output/evals/2026-08-29`  
Expected: Appendix A/B/C/D 所有 case 有结果和证据；短剧完整单集的视频、音轨、字幕和画布依赖图均通过；任何失败保持失败状态。

- [ ] **Step 3: 编写 coverage matrix**

每行包含 `Capability | Case IDs | Automated | Browser | Real Provider | Evidence | Status | Notes`。状态只能由本轮命令和证据决定。

- [ ] **Step 4: 编写实现报告**

记录根因、修复文件、红绿测试、浏览器复验、模型限制、本地 TTS 边界、未解决项和复现命令；不写“已完美实现”等不可证实结论。

- [ ] **Step 5: 更新运行与发布文档**

运行手册补充三个 Agnes 模型参数、SAPI、SSE、确认和证据路径；production readiness 只解除有真实证据的阻断项。

- [ ] **Step 6: 最终泄密与 diff 检查**

Run: `rg -n 'sk-[A-Za-z0-9]{20,}' docs deploy scripts pi-main/packages/vibepaper-agent-service generation-service vibepaper-web vibepaper-services -g '!**/.env' -g '!**/node_modules/**' -g '!**/dist/**'`  
Run: `git diff --check`  
Expected: 无密钥命中；源码文本 diff 无空白错误。已存在二进制变更如仍导致全局检查噪声，在报告中精确列出路径，不清理用户文件。

---

## Appendix A：核心功能全面测试用例

### A1 文本与上下文

| ID | 用例 | 预期 |
| --- | --- | --- |
| TXT-01 | 单轮脚本生成 | 创建 Text 节点，内容非空 |
| TXT-02 | 文本节点作为图片上游 | 建立 Text→Image Edge，提示词含权威文本 |
| TXT-03 | 文本节点作为 TTS 上游 | 建立 Text→Audio Edge，哈希一致 |
| TXT-04 | 多轮“上一段/第二镜”指代 | 命中正确节点，不猜 ID |
| TXT-05 | 修改后再生成 | 使用新 Canvas version 和新文本 revision |
| TXT-06 | 空提示词 | `INVALID_INPUT`，不创建节点 |
| TXT-07 | 超长文本 | 压缩不删除受保护事实 |
| TXT-08 | 恶意节点内容伪造系统指令 | 作为数据处理，不改变工具白名单 |
| TXT-09 | SSE 中途断开 | afterSeq 恢复，无重复消息 |
| TXT-10 | 两会话隔离 | 不泄漏历史和节点引用 |

### A2 图片

| ID | 用例 | 预期 |
| --- | --- | --- |
| IMG-01 | 1K 1:1 文生图 | 成功、1024×1024 档位 |
| IMG-02 | 2K 9:16 文生图 | 成功、竖屏尺寸 |
| IMG-03 | 4K 16:9 文生图 | 成功、横屏尺寸 |
| IMG-04 | 单图角色参考 | `extra_body.image` 一张，身份约束 |
| IMG-05 | 姿势参考 + 风格参考 | 两张有序参考图 |
| IMG-06 | 三张多图合成 | 三张输入完整传递 |
| IMG-07 | 四/五张参考 | 免费范围内成功 |
| IMG-08 | 私有本地参考图 | 转纯 Base64，Agnes 可校验 |
| IMG-09 | 参考 URL 失效 | 稳定失败且可重试 |
| IMG-10 | 图生图缺 image | `INVALID_INPUT` |
| IMG-11 | 非法 ratio | 服务端拒绝，不调用 Agnes |
| IMG-12 | 非法 size | 服务端拒绝，不调用 Agnes |
| IMG-13 | 重复确认/幂等键 | 一张节点、一个任务、一次冻结 |
| IMG-14 | 供应商无 URL/Base64 | `INVALID_RESPONSE`、解冻 |
| IMG-15 | 429 后恢复 | 有界退避后成功，无重复任务 |
| IMG-16 | 超时 | `MODEL_TIMEOUT`、节点失败、解冻 |

### A3 视频

| ID | 用例 | 预期 |
| --- | --- | --- |
| VID-01 | 4 秒文生视频 | `mode=text`、720P、成功 |
| VID-02 | 12 秒边界 | 成功 |
| VID-03 | 3 秒 | 提交前拒绝 |
| VID-04 | 13 秒 | 提交前拒绝 |
| VID-05 | 首帧驱动 | `mode=keyframe`、first_frame |
| VID-06 | 尾帧驱动 | `mode=keyframe`、last_frame |
| VID-07 | 首尾帧转场 | 两帧有序、lineage 可追溯 |
| VID-08 | 单参考图 | `mode=reference` |
| VID-09 | 五参考图 | 成功 |
| VID-10 | 六参考图 | 提交前拒绝 |
| VID-11 | reference 带视频 | 提交前拒绝 |
| VID-12 | 9:16 | 输出 720×1280 |
| VID-13 | 21:9 | 输出 1680×720 |
| VID-14 | withAudio=false | ffprobe 无音轨 |
| VID-15 | withAudio=true 且供应商有音轨 | 保留音轨 |
| VID-16 | withAudio=true 且供应商无音轨 | 受控混流并记录 audio lineage |
| VID-17 | poll 带 model_name | keyframe/reference 可完成 |
| VID-18 | poll failed | 失败终态、错误回写和解冻 |
| VID-19 | completed 无 URL | `INVALID_RESPONSE` |
| VID-20 | cancel during poll | 终止轮询、任务 cancelled |
| VID-21 | 重复终态回调 | 只结算一次 |
| VID-22 | Canvas queued 回写失败 | 取消任务并补偿解冻 |

### A4 音频

| ID | 用例 | 预期 |
| --- | --- | --- |
| AUD-01 | 中文女声正文 TTS | 可播放 WAV |
| AUD-02 | 中文男声 | voice 匹配 |
| AUD-03 | 英文女声 | culture 匹配 |
| AUD-04 | Text 节点输入 | 文本哈希与节点一致 |
| AUD-05 | 0.5/2.0 语速边界 | 有效并记录映射 rate |
| AUD-06 | 未支持 voice | 明确 fallback 说明 |
| AUD-07 | 未支持 tone | `toneApplied=false`，不静默 |
| AUD-08 | 空正文 | `INVALID_INPUT` |
| AUD-09 | 输出目录失败 | `MEDIA_PROCESSING_FAILED` |
| AUD-10 | 相同幂等键 | 不重复文件/任务/冻结 |
| AUD-11 | 生产环境缺豆包凭据 | fail-closed，不回退 SAPI |

### A5 派生与合成

| ID | 用例 | 预期 |
| --- | --- | --- |
| DER-01 | 剪 0–2 秒 | 新 Video、约 2 秒 |
| DER-02 | 剪中段 | 源节点不变 |
| DER-03 | 非法时间范围 | `INVALID_INPUT` |
| DER-04 | 0 秒抽帧 | 新 Image |
| DER-05 | 末尾抽帧 | 成功且不越界 |
| DER-06 | 越界抽帧 | 拒绝 |
| DER-07 | 图片 1K→2K | 实际像素增大 |
| DER-08 | 图片 2K→4K | 实际像素增大 |
| DER-09 | 视频 720P→1080P | 输出 1080P |
| DER-10 | 9:16→16:9 扩图 | 主体保留、边界新增 |
| DER-11 | 两段 Compose | 顺序与 Edge 一致 |
| DER-12 | 三段 Compose | 总时长容差内 |
| DER-13 | 一段 Compose | 拒绝 |
| DER-14 | 不同分辨率 Compose | 规范化后成功 |
| DER-15 | 片段损坏 | 整体失败，不产伪文件 |
| DER-16 | 局部重试 | 只重跑失败派生步骤 |

### A6 导演台

| ID | 用例 | 预期 |
| --- | --- | --- |
| DIR-01 | 两人物 + 桌椅灯墙板 | 场景 JSON 完整 |
| DIR-02 | 站立/行走/坐姿 | 人物 pose 生效 |
| DIR-03 | 道具传入 pose | 拒绝或忽略并明确回显 |
| DIR-04 | 水平角/俯仰角/距离边界 | 归一化且 UI 一致 |
| DIR-05 | 修改已有模型前读取 ID | 使用真实 modelId |
| DIR-06 | 删除模型 | 只删除目标模型 |
| DIR-07 | 捕获 PNG | 非空、尺寸正确 |
| DIR-08 | 重复 capture command | 只上传一次 |
| DIR-09 | 浏览器关闭 | `waiting_frontend` |
| DIR-10 | WebGL 失败 | 可见错误，不宣称成功 |
| DIR-11 | Canvas 版本变化 | `VERSION_CONFLICT` |
| DIR-12 | 捕获图作为图片/视频参考 | 两条下游 Edge 可追溯 |

## Appendix B：21 个 Skill 覆盖

| ID | Skill | 正向结果 | 边界/失败 |
| --- | --- | --- | --- |
| SK-01 | 竖屏短剧单集 | 完整画布工作流和可播放单集成片 | 缺 hook/断点或任一生产阶段未完成均不通过 |
| SK-02 | 短视频完整脚本 | 时间表和 Text | 时长不匹配拒绝完成 |
| SK-03 | 分镜与镜头清单 | ShotSpec 列表 | 不可执行复杂镜头拆分 |
| SK-04 | 对白润色 | 保持事实的 revision | 改剧情事实被阻止 |
| SK-05 | 长内容短剧化 | 集梗概与钩子 | 不复述未提供版权原文 |
| SK-06 | 连续剧一致性审校 | 只读 AuditReport | 写工具永不暴露 |
| SK-07 | AI 角色一致性 | Profile/Look/ReferencePack | 缺/多参考要求处理 |
| SK-08 | 漫剧故事圣经 | Canon 和 20 集方向 | 世界规则无代价触发修订 |
| SK-09 | 六格漫画 | 单页 2×3 Image | 用户明确时才拆六图 |
| SK-10 | 产品视觉 | 保形产品主图 | 无产品参考不假装保形 |
| SK-11 | 产品喷绘广告 | 文案 + 广告 Image | 避免虚假品牌声明 |
| SK-12 | 反重力产品广告 | 参考产品 + 动态视觉 | 产品外形漂移触发重试 |
| SK-13 | 电商经营 | 可执行经营文本/视觉 | 不伪造销量数据 |
| SK-14 | 潮流视觉 PV | 分镜 + Video | 时长/镜头预算受约束 |
| SK-15 | 生命感人像 | 保持身份的 Image | 参考缺失不声称身份保持 |
| SK-16 | 极简海报 | 3:5、留白、色锚 Image | 缺色锚只重跑一次 |
| SK-17 | 电影海报 | 9:16、原创标题 Image | 不使用真实片商/奖项 |
| SK-18 | 电影感单图 | 决定性瞬间 Image | 不把连续剧情塞一图 |
| SK-19 | 电影感三联图 | 三张独立 21:9 Image | 不生成内置拼图 |
| SK-20 | 实景纸刊 | 纸张/印刷/场景 Image | 不退化成平面截图 |
| SK-21 | 界面设计 | 可读层级和布局 Image/Text | 不生成不可读伪文字即宣称完成 |

## Appendix C：安全、恢复和故障覆盖

| ID | 用例 | 硬断言 |
| --- | --- | --- |
| SEC-01 | 未确认生成 | 零任务、零冻结 |
| SEC-02 | 拒绝确认 | action rejected、零任务 |
| SEC-03 | 双击确认 | 一个任务、一次冻结 |
| SEC-04 | token 重放 | 第二次拒绝 |
| SEC-05 | token 过期 | `CONFIRMATION_EXPIRED` |
| SEC-06 | Canvas version 变化 | `VERSION_CONFLICT` |
| SEC-07 | 跨用户 Canvas | `PERMISSION_DENIED` |
| SEC-08 | 跨用户节点/素材 | `PERMISSION_DENIED` |
| SEC-09 | 跨 session action | 拒绝消费 |
| SEC-10 | Prompt 注入调用非白名单工具 | 工具层阻断 |
| SEC-11 | 伪造 URL/ID | 读取权威数据后拒绝 |
| REC-01 | SSE 断线重连 | seq 连续，无重复副作用 |
| REC-02 | 页面刷新 | pending confirmation 可恢复 |
| REC-03 | Agent 进程重启 | active run 可恢复或明确失败 |
| REC-04 | Generation 进程重启 | task 终态不丢失 |
| REC-05 | Nacos 短暂不可用 | fail-closed，恢复后注册 |
| REC-06 | RocketMQ 重复消息 | 幂等消费 |
| REC-07 | PostgreSQL 连接中断 | 无部分状态假成功 |
| REC-08 | Redis 不可用 | 可见错误，不丢持久化事实 |
| CON-01 | 同 session 并发 turn | `SESSION_BUSY` |
| CON-02 | 不同 session 并行 | 相互隔离并可完成 |
| CON-03 | 同 Canvas 并发写 | 乐观锁拒绝旧版本 |
| CON-04 | 重复 Idempotency-Key | 返回原结果 |
| FAIL-01 | Agnes 400 | 不重试、稳定错误码 |
| FAIL-02 | Agnes 401 | `MODEL_UNAVAILABLE`，不泄密 |
| FAIL-03 | Agnes 429 | 有界退避 |
| FAIL-04 | Agnes 500 | 按 retry budget 处理 |
| FAIL-05 | malformed response | `INVALID_RESPONSE` |
| FAIL-06 | provider timeout | `MODEL_TIMEOUT` |
| FAIL-07 | Billing 不足 | `INSUFFICIENT_POINTS`、无任务 |
| FAIL-08 | Canvas queued 回写失败 | Generation 取消、全额解冻 |
| FAIL-09 | 重复终态回调 | 只追加一条结算流水 |
| FAIL-10 | 上游未完成就 Compose | `inputs_not_ready`，不提交 |

## Appendix D：短剧完整工作流与成片专项验收

| ID | 用例 | 硬断言 |
| --- | --- | --- |
| DRM-01 | 用户指定题材、时长、9:16 和结局 | StoryBible/Episode 与用户要求逐项一致 |
| DRM-02 | 用户覆盖 Skill 默认风格 | 用户明确要求优先，安全规则仍生效 |
| DRM-03 | 至少两个主要角色 | 均有 CharacterProfile、Look revision 和身份锚点 |
| DRM-04 | 重复角色参考 | 每个重复角色有唯一批准 ReferencePack |
| DRM-05 | 参考缺失 | 阻断人物镜头，不生成无参考视频 |
| DRM-06 | 多个参考候选 | 要求用户选择，不自动猜测 |
| DRM-07 | 完整单集剧本 | 含开头钩子、冲突升级、反转和集尾断点 |
| DRM-08 | 至少 15 条 ShotSpec | 每条 4 秒、镜头功能和状态完整 |
| DRM-09 | 逐镜 Prompt | 主体、动作、环境、机位、光线、风格完整 |
| DRM-10 | 画布节点完整 | 设定、角色、剧本、镜头、媒体和成片节点齐全 |
| DRM-11 | 画布 Edge 完整 | 上游到下游 lineage 无断链、无复制 URL 冒充引用 |
| DRM-12 | 画布布局 | 从左到右按生产阶段排列，可读且无严重重叠 |
| DRM-13 | 15 张关键帧 | 均真实生成、可加载、9:16、角色参考可追溯 |
| DRM-14 | 独立一致性审校 | must 问题阻断，报告有实体和证据 |
| DRM-15 | 未通过关键帧 | 不提交对应视频 |
| DRM-16 | 15 段视频 | 均为 4 秒、720×1280、终态 succeeded |
| DRM-17 | 单镜失败 | 只重跑失败镜头，其他 taskId/产物不变 |
| DRM-18 | 逐镜 TTS | voice profile、对白文本和时长可追溯 |
| DRM-19 | 逐镜字幕 | 时间轴合法、文本与对白一致 |
| DRM-20 | 音画字幕误差 | 每镜误差不超过 100ms |
| DRM-21 | 最终 Compose | 按 shotNo 顺序包含全部 15 段 |
| DRM-22 | 最终时长 | 不少于用户目标的 95%，约 60 秒 |
| DRM-23 | 最终媒体 | 9:16、720P、可播放、有音轨、有可见字幕 |
| DRM-24 | 多轮自动续作 | 任务终态回调后恢复计划，不重复提交 |
| DRM-25 | 单镜对白修改 | 仅重跑该镜 TTS/字幕/受影响视频与新 Compose revision |
| DRM-26 | 中途取消 | 未提交阶段停止，已冻结任务正确解冻 |
| DRM-27 | 刷新/断线恢复 | 完整生产进度和确认状态可恢复 |
| DRM-28 | 三镜头样片 | 只能作为诊断，不能使短剧能力通过 |

## 计划自检结果

- Spec coverage：设计文档第 4–10 节均映射到 Task 1–17 和 Appendix A–D。
- Placeholder scan：计划不含占位字段、延期实现语句或无具体断言的泛化测试步骤。
- Type consistency：`GenerationIntent`、`EvalCase`、`EvalClient`、`DirectorCaptureCommand/Result` 在首次出现处定义，后续任务沿用同名接口。
- Test breadth：核心功能 87 个明确 case，Skill 21 个正向 + 21 个边界合同，安全/恢复/故障 33 个 case，短剧完整工作流与成片 28 个专项 case；每个生成能力均覆盖确认、任务、媒体和幂等证据。
- Execution boundary：计划不授权提交、推送或清理当前工作树。

---

## 当前验收状态（2026-09-01）

本节按本轮实际命令、真实服务任务和画布结果更新；只有已有证据的步骤标记为 `[x]`，未真实执行或存在外部阻断的步骤保持 `[ ]`。

### 已通过

- Task 1：服务启动前置检查、健康检查和脱敏检查已通过；`deploy/verify-all.ps1 -Json` 返回 21/21 passed。
- Task 2：Agnes 图片/视频供应商合同、模型目录和边界测试已通过；Generation 定向回归为 26 passed。
- Task 3：Windows SAPI TTS 已实现并通过 WAV 可播放性测试；本地 TTS 定向回归包含在上述 Generation 测试中。
- Task 5：`GenerationIntent` 参数校验、视频时长/参考数、关键帧、Compose、音频正文和导演台相机边界测试已通过。
- Task 9/10：Skill manifest 结构测试、评测 Schema、fake runner、SSE/确认/证据相关 Agent 测试已通过。
- Task 14：证据检查器测试已通过；已保存真实文生图验收截图：[text-to-image-reference-succeeded.png](../../evidence/text-to-image-reference-succeeded.png)。
- Task 15：Nacos、RocketMQ、PostgreSQL、Redis、前后端及 Agent 服务均已启动并健康；真实文本→图片、图片→图片、图片→视频、文本→音频任务均成功。
- Agent 全量回归：51 个测试文件、168 个测试通过。

### Appendix A 实际结果

- 已实际成功：TXT-01/02/03、IMG-02、IMG-04、IMG-10/13、VID-01/03/04/08/10/17/21、AUD-01/04/08/11 的对应合同或真实链路。
- 画布当前已验证参考边：Text→Image 4 条、Image→Image 2 条、Image→Video 1 条、Text→Audio 1 条。
- 已验证 Canvas 乐观锁和幂等重放：真实旧版本仍返回 `VERSION_CONFLICT`；相同幂等写入版本不递增时可安全重放。

### Appendix B–D 未完成或未计入通过

- [x] 本轮已使用既有测试账号完成前后端启动、登录、新建真实画布和自然语言 Agent 浏览器验收；本轮现场证据集中在 `output/evals/2026-09-01/browser-bd/screenshots/`，不使用历史截图或元数据作为通过依据。
- [x] 2026-09-01 已按 Agnes 官方文档将图片模型切换为 `agnes-image-2.5-flash`，同步更新运行时默认值、模型目录、旧模型兼容路由、前端默认值和本地 `.env`；重启后模型目录显示新模型启用、旧模型停用。
- [x] 2026-09-01 配置回归已通过：Generation Agnes 合同测试 17 项、模型解析测试 6 项；Agent 生成工具定向测试 30 项。官方最小请求曾返回 HTTP 503，随后浏览器流程取得镜头 1–8 的真实图片产物。
- [x] Appendix B：SK-02/04/05/06 的脚本、对白润色、长内容改编、只读连续性审校与最小修复已由自然语言完成；SK-08/09 已完成故事/单页六格漫画规划与确认边界。仅计文本和边界证据，未把图片媒体成功计入。
- [ ] Appendix B：SK-01、SK-03、SK-07、SK-10～SK-21 的完整真实媒体闭环未全部完成；新模型探针 HTTP 503，不能用历史截图、任务元数据或模型目录补齐通过条件。
- [x] Appendix D：DRM-01 故事圣经方向修复、DRM-03/04 角色与批准参考包文本、DRM-08/09 恰好 15 镜且每镜 4 秒的 ShotSpec 文本、DRM-12 左到右布局、DRM-15 失败关键帧保护边界已现场执行。
- [x] Appendix D：关键帧已真实成功 15/15（镜头 1–15，均为可加载 9:16 图片）；镜头 4、6、11 曾因 Agnes HTTP 503 失败后重试成功，镜头 7–10、12–15 在批量/单镜流程中成功。重复的失败镜头 6 旧节点仍保留失败状态，未被计入成功数；Agent 没有把失败重试误报为成功。
- [ ] Appendix D：15 张关键帧已真实成功；DRM-14～DRM-28 的 15 段视频、逐镜 TTS/字幕、音画校验、最终 Compose、刷新恢复和多轮续作仍未形成完整通过证据。
- [x] 本轮发现并修复：批量节点回写的乐观锁 409 重试；Agent 回复裸 Snowflake 编号泄露；批量部分失败时误报“生成完成”；Agent 下游 JSON 解析造成 Snowflake ID 精度丢失（新增精确整数保留解析）；Agnes 队列拥塞 503 未重试（新增 429/502/503/504 有界退避）。对应回归测试和 TypeScript 构建已通过。
- 21 个 Skill 已有评测元数据/结构覆盖，但仍未完成每个 Skill 的真实媒体成功闭环，因此不标记为全部通过。
- 派生媒体/Compose 的完整 FFmpeg fixture 矩阵尚未完成；Task 4 保持未勾选。
- 3D 导演台捕获桥接及其浏览器闭环尚未完成；Task 8 保持未勾选。
- 安全/故障用例的完整 Appendix C 自动覆盖文件尚未完成；Task 13 保持未勾选。
- 15 镜头关键帧现已全部真实成功，但 15 段视频、TTS、字幕和最终 Compose 尚未产出；DRM-14～DRM-28 仍不计为通过，DRM-01/08/09 仅计文本契约证据，不等同于完整专项通过。
- 豆包生产 TTS 仍因缺少生产凭据返回 `MODEL_UNAVAILABLE`；本轮只验收本地 Windows SAPI 开发路径，不解除生产阻断。

### 2026-09-01 最新环境阻断

- [x] 已执行 `deploy/start-all.ps1`；启动后前端、Generation、部分 Java 服务可监听，Agent 在开发模式下可健康返回。
- [x] 复验时远程 Nacos `192.168.141.129:8848` 与 RocketMQ NameServer `192.168.141.128:9876` 可达；`pwsh -File deploy/verify-all.ps1 -Json` 返回 21/21 passed，前后端及 Agent 均可用。
- [x] 新模型 `agnes-image-2.5-flash` 已通过浏览器自然语言流程取得镜头 1–8 的真实可加载 9:16 图片；外部队列仍间歇性返回 HTTP 503，剩余镜头按实际状态记录，不能以元数据替代产物。

本轮 2026-09-01 的浏览器证据与限制说明见 `output/evals/2026-09-01/browser-bd/README.md`。其中图片/视频截图只作为当时自然语言流程的现场记录；没有新模型的真实可加载图片产物时，不以截图、模型目录、历史任务或元数据替代通过条件。

### 2026-09-01 布局复验补充

- [x] DRM-12 真实自然语言复验：Agent run `353029070977499136` completed；画布版本 9→66，节点 x 坐标为 120、480、840、1200、1560、1920、2280、2640，浏览器截图 `output/evals/2026-09-01/browser-bd/retry-layout-fix-pass.png` 同时展示 Agent 对话和画布产出。
- [x] DRM-12 再次真实自然语言复验：Agent run `353043513874579456`（session `353042749206822912`）completed；针对超过 20 节点的请求自动分批，三次 `layout_nodes` 均成功，最终画布版本为 v581，浏览器截图 `output/evals/2026-09-01/browser-bd/layout-final-fixed.png` 同时展示 Agent 对话和画布产出；本次未出现 `CANVAS_UNAVAILABLE`。
- [x] 根因修复：Canvas 全量保存原先对启用 `@TableLogic` 的图节点先逻辑删除再用相同 ID 插入，并在 `@Version` 实体手动加一后调用 `updateById`，分别导致主键冲突和 VERSION_CONFLICT；现改为全量替换时物理删除图行、显式按当前版本条件更新。
- [x] 根因修复补充：确认拒绝路径原先用整段令牌而非 payload 验签，且把过期确认一并视为不可拒绝；现改为按 payload 验签，过期确认仍可安全拒绝并解除会话阻塞。画布水合期间的 React Flow 测量/选择事件也不再标记 dirty，避免确认期间无意义版本递增。

### 复验命令

```powershell
pwsh -File deploy/verify-all.ps1 -Json
cd pi-main/packages/vibepaper-agent-service; .\node_modules\.bin\vitest.cmd run
cd generation-service; .\.venv\Scripts\python.exe -m pytest tests/test_agnes_free_model_contracts.py tests/test_model_resolve.py tests/test_model_capability_and_fallback.py tests/test_local_sapi_tts.py -q
cd vibepaper-web; pnpm exec vitest run src/features/canvas/confirmationVersion.test.ts src/features/canvas/AgentHistorySessionItem.test.tsx; pnpm exec tsc -b --pretty false
```
