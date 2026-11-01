'use strict'
// QA: node start-native-codex-mcp-test.cjs <isolated run directory> <absolute Codex CLI> local|image|video|readback
const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process')
const [dir, binary, phase] = process.argv.slice(2)
if (!['local', 'image', 'video', 'readback'].includes(phase)) process.exit(2)
const workspace = path.resolve(__dirname, '../..'),
  tempRoot = path.join(workspace, '.test-temp')
// Accept only a live, ACL-restricted directory created by our Main/Canvas QA.
const real = (p) => fs.realpathSync(p)
if (
  path.dirname(real(dir)) !== real(tempRoot) ||
  !/^vibepaper-native-form-/.test(path.basename(dir)) ||
  fs.existsSync(path.join(dir, 'result.json')) ||
  fs.existsSync(path.join(dir, 'stop.request'))
)
  throw Error('No live test canvas')
if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Run in a visible interactive terminal')
if (!path.isAbsolute(binary) || !/^codex(?:\.exe)?$/i.test(path.basename(binary)))
  throw Error('Expected the Codex CLI executable')
const ready = JSON.parse(fs.readFileSync(path.join(dir, 'ready.json')))
const projectRoot = real(ready.projectPath),
  parent = real(path.join(dir, 'project'))
if (projectRoot !== parent && path.dirname(projectRoot) !== parent)
  throw Error('Unexpected project directory')
const allowedTomls = [
  path.join(real(dir), 'codex-native-confirmation.toml'),
  path.join(projectRoot, '.codex', 'config.toml'),
]
if (!allowedTomls.includes(real(ready.codexTomlPath))) throw Error('Unexpected test config')
const lines = fs.readFileSync(ready.codexTomlPath, 'utf8').split(/\r?\n/)
let section = '',
  cfg = {},
  env = {}
for (const line of lines) {
  if (line.startsWith('[')) {
    section = line.includes('.env]') ? 'env' : 'server'
    continue
  }
  const m = line.match(/^([a-zA-Z_]+)\s*=\s*(.+)$/)
  if (m) (section === 'env' ? env : cfg)[m[1]] = JSON.parse(m[2])
}
const server = String(ready.serverName)
if (!/^[a-z0-9_]+$/.test(server) || !Array.isArray(cfg.args) || !cfg.command)
  throw Error('Invalid restricted test export')
const media = server === 'vibepaper_native_agnes_media'
if (media ? phase === 'local' : server !== 'vibepaper_native_acceptance' || phase !== 'local')
  throw Error('Wrong phase for this canvas')
const bridge = path.resolve(__dirname, '../src/mcp-node-entry.cjs')
if (
  real(cfg.command) !== real(require('electron')) ||
  real(cfg.args[0]) !== real(bridge) ||
  cfg.args.length !== 8 ||
  cfg.args[1] !== '--mcp-stdio' ||
  cfg.args[2] !== '--mcp-instance-file' ||
  real(cfg.args[3]) !== real(path.join(dir, 'VibePaper', 'mcp-instance.json')) ||
  cfg.args[4] !== '--mcp-client-id' ||
  cfg.args[6] !== '--mcp-grant-id' ||
  ![cfg.args[5], cfg.args[7]].every((x) => /^[a-f0-9-]{36}$/i.test(x)) ||
  Object.keys(env).sort().join(',') !== 'APPDATA,ELECTRON_RUN_AS_NODE' ||
  real(env.APPDATA) !== real(dir) ||
  env.ELECTRON_RUN_AS_NODE !== '1'
)
  throw Error('Unexpected bridge configuration')
// Never replay a billable phase after an earlier launch or any persisted task.
if (media && phase !== 'readback') {
  const profile = path.join(dir, 'VibePaper'),
    project = real(JSON.parse(fs.readFileSync(path.join(profile, 'recent-project.json'))).projectDirectory)
  if (path.dirname(project) !== real(path.join(dir, 'project'))) throw Error('Unexpected acceptance project')
  const { DatabaseSync } = require('node:sqlite'),
    db = new DatabaseSync(path.join(project, '.vibepaper', 'project.sqlite'), { readOnly: true })
  try {
    if (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE modality=?').get(phase).n)
      throw Error('Existing task: use readback')
  } finally {
    db.close()
  }
  fs.writeFileSync(path.join(dir, 'native-launch-' + phase + '.lock'), '', { flag: 'wx' })
}
const attempt = phase + '-' + Date.now()
const observerSpec = path.join(dir, attempt + '-native-tui-observer.json')
const evidencePath = path.join(dir, attempt + '-native-tui-wire.json')
fs.writeFileSync(
  observerSpec,
  JSON.stringify({
    command: cfg.command,
    args: cfg.args,
    env,
    evidencePath,
    fingerprintMediaPreviews: media,
  }),
  { flag: 'wx' },
)
const cwd = path.join(dir, 'native-client-workspace')
fs.mkdirSync(cwd, { recursive: true })
const prompts = {
  local:
    '只用 ' +
    server +
    ' 的 MCP 工具。读取画布和模型。宿主已核验当前节点没有任务，不要用未知 ID 查询操作。然后为已有的唯一文本目标节点使用 native-confirmation-fixture-text 本地模型准备一次生成，让我在 Codex 原生确认表单选择拒绝。不要创建额外节点，不要用终端、文件、其他服务或云端模型；若拒绝或失败，停止，不要再提案。',
  image:
    '只用 ' +
    server +
    ' 的 MCP 工具。读取授权画布、模型和已有任务；此处按宿主已验证的零图片任务基线，使用已有空图片节点（如无则创建一个），用 Agnes Image 2.5 Flash 为蓝色陶瓷方块置于白色影棚背景、柔和自然阴影、无文字，生成一张 1K、1:1 图片。只提交一次，在原生表单等我确认；若已有任务只查询。成功后用 MCP 读取任务结果元数据和预览。不要运行终端、读写文件、使用其他服务或生成视频，不要重试付费生成。',
  video:
    '只用 ' +
    server +
    ' 的 MCP 工具。读取授权画布、模型和已有任务；此处按宿主已验证的零视频任务基线，使用已有空视频节点（如无则创建一个），用 Agnes Video 2.5 Flash 生成一条 4 秒 720P 16:9 纯文本视频：蓝色陶瓷方块在白色影棚中缓慢旋转、固定镜头、无文字。不使用参考媒体。只提交一次，在原生表单等我确认；若已有任务只查询。成功后用 MCP 读取任务结果元数据和预览。不要运行终端、读写文件、调用其他服务或生成图片；遇队列、超时或中断只查已有任务，不重新生成。',
  readback:
    '只用 ' +
    server +
    ' 的 MCP 工具。核对已有图片和视频任务，读取结果元数据与预览，不创建节点、提案或任务，不使用终端或文件。',
}
const list =
  phase === 'readback'
    ? [
        'get_context',
        'get_canvas_summary',
        'get_node_detail',
        'list_models',
        'check_task_status',
        'read_task_output',
        'list_canvas_tasks',
        'get_operation',
      ]
    : cfg.enabled_tools
if (!Array.isArray(list) || !list.length) throw Error('Missing scoped tools')
const overrides = {
  command: process.execPath,
  args: [path.join(__dirname, 'observe-mcp-client.cjs'), observerSpec],
  ...(list.length ? { enabled_tools: list } : {}),
  default_tools_approval_mode: 'approve',
  startup_timeout_sec: 150,
  tool_timeout_sec: 660,
  required: true,
}
const args = [
  ...require('./codex-qa-model.cjs').codexExecModelArguments(),
  '--cd',
  cwd,
  '--disable',
  'shell_tool',
  '--sandbox',
  'read-only',
]
for (const [k, v] of Object.entries(overrides))
  args.push('-c', 'mcp_servers.' + server + '.' + k + '=' + JSON.stringify(v))
const verifiedBaseline = media && phase !== 'readback'
  ? '验收宿主刚通过只读 TaskStore 核对：此独占测试画布中本阶段已有任务数为 0，未有待续接任务。可用时请按对应模态列出当前画布的任务；发现已有任务就停止生成、只读回已有结果。如果旧版未提供任务列表，请使用已核验的前置条件，不要用未知 ID 查询。读取画布和模型后执行以下请求。'
  : ''
args.push(verifiedBaseline + prompts[phase])
process.title = 'Pi-Paper: Terra max - ' + phase
const safeEnv = { ...process.env }
for (const k of Object.keys(safeEnv))
  if (/^AGNES|^VIBEPAPER.*KEY|^CODEX_THREAD_ID$|^CODEX_INTERNAL|^CODEX_MANAGED_BY_/i.test(k))
    delete safeEnv[k]
if (process.platform === 'win32' && safeEnv.TERM === 'dumb' && process.stdin.isTTY && process.stdout.isTTY)
  safeEnv.TERM = 'xterm-256color'
const p = spawnSync(binary, args, { cwd, env: safeEnv, stdio: 'inherit', shell: false })
fs.writeFileSync(
  path.join(dir, attempt + '-native-tui-exit.json'),
  JSON.stringify({ exitCode: p.status, signal: p.signal, errorCode: p.error?.code ?? null }),
)
