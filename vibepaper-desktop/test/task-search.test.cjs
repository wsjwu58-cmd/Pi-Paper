const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

async function openTestProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-task-search-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Task Search Test')
  return { store, ...opened }
}

async function createTask(store, project, index, input = {}) {
  return store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: input.modality ?? 'text',
    providerType: input.providerType ?? 'cloud',
    providerId: input.providerId ?? 'provider-test',
    modelId: input.modelId ?? 'model-test',
    idempotencyKey: `task-search-${index}`,
    parameters: input.parameters ?? { prompt: `ordinary prompt ${index}` },
  })
}

test('task search filters every task before applying the bounded page and matches prompts without returning them', async (t) => {
  const { store, project } = await openTestProject(t)
  let match
  for (let index = 0; index < 25; index += 1) {
    const isMatch = index === 24
    const task = await createTask(store, project, index, isMatch ? {
      modality: 'image',
      providerId: 'agnes',
      modelId: 'image-model',
      parameters: { modelParams: { prompt: 'A Secret Needle in the Haystack' } },
    } : undefined)
    if (isMatch) match = task
  }

  const dateRange = { fromTime: Date.now() - 60_000, toTime: Date.now() + 60_000 }
  const result = await store.searchTasks(project.projectId, {
    page: 1,
    pageSize: 20,
    keyword: 'NEEDLE',
    model: 'agnes image-model',
    modality: 'image',
    status: 'queued',
    ...dateRange,
  })

  assert.equal(result.total, 1)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].taskId, match.taskId)
  assert.equal(result.items[0].modelId, 'image-model')
  assert.equal(Object.hasOwn(result.items[0], 'parameters'), false)

  const paged = await store.searchTasks(project.projectId, { page: 3, pageSize: 10 })
  assert.equal(paged.total, 25)
  assert.equal(paged.page, 3)
  assert.equal(paged.items.length, 5)
  assert.deepEqual(await store.searchTasks(project.projectId, { keyword: "' OR 1=1 --" }), {
    items: [], total: 0, page: 1, pageSize: 20,
  })
})

test('task search rejects unbounded pages and invalid filters', async (t) => {
  const { store, project } = await openTestProject(t)
  await assert.rejects(store.searchTasks(project.projectId, { pageSize: 101 }), /分页参数无效/u)
  await assert.rejects(store.searchTasks(project.projectId, { modality: 'unknown' }), /模态筛选无效/u)
  await assert.rejects(store.searchTasks(project.projectId, { status: 'expired' }), /状态筛选无效/u)
  await assert.rejects(store.searchTasks(project.projectId, { fromTime: 2, toTime: 1 }), /日期范围无效/u)
  await assert.rejects(store.searchTasks(project.projectId, { keyword: 'x'.repeat(201) }), /搜索条件无效/u)
})

test('task search is wired through a restricted IPC and typed bridge without adding prompt data to list summaries', async () => {
  const root = path.resolve(__dirname, '..', '..')
  const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8')
  const [localCore, main, preload, bridgeTypes, history] = await Promise.all([
    read('vibepaper-desktop/src/local-core.cjs'),
    read('vibepaper-desktop/src/main.cjs'),
    read('vibepaper-desktop/src/preload.cjs'),
    read('vibepaper-web/src/desktop/desktop-bridge.d.ts'),
    read('vibepaper-web/src/features/history/HistoryPage.tsx'),
  ])

  assert.match(localCore, /case 'task:search':\s+return store\.searchTasks\(payload\?\.projectId, payload\?\.query\)/u)
  assert.match(main, /ipcMain\.handle\('desktop:task:search',[\s\S]*assertTrustedSender\(event\)[\s\S]*pageSize > 100[\s\S]*localCore\.request\('task:search'/u)
  assert.match(main, /items: result\.items\.map\(\(task\) => \(\{[\s\S]*taskId: task\.taskId[\s\S]*\}\)\)/u)
  assert.match(preload, /searchTasks: \(projectId, query\) => ipcRenderer\.invoke\('desktop:task:search', projectId, query\)/u)
  assert.match(bridgeTypes, /searchTasks\(projectId: string, query: DesktopTaskSearchQuery\): Promise<DesktopTaskSearchResult>/u)
  assert.match(history, /bridge\.searchTasks\(project\.projectId, query\)/u)
  assert.match(history, /adapter\.searchTasks\(searchQuery\)/u)
})
