const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { buildDesktopAgentModelDirectory } = require('../src/agent-model-directory.cjs')
const { deleteAgentNodes } = require('../src/agent-node-deletion.cjs')

let nextPlanId = 9300000000

function workerHarness(localCoreRequest) {
  const filename = path.resolve(__dirname, '../src/agent-worker.cjs')
  const source = require('node:fs').readFileSync(filename, 'utf8')
  const parentPort = new EventEmitter()
  parentPort.postMessage = (message) => {
    if (message?.kind !== 'agent-local-core-request') return
    const request = structuredClone(message)
    Promise.resolve()
      .then(() => localCoreRequest(request.method, request.payload))
      .then(
        (result) => parentPort.emit('message', {
          data: { kind: 'agent-local-core-response', requestId: request.requestId, ok: true, result: structuredClone(result) },
        }),
        (error) => parentPort.emit('message', {
          data: {
            kind: 'agent-local-core-response',
            requestId: request.requestId,
            ok: false,
            errorCode: /^[A-Z0-9_]{1,120}$/u.test(error?.code ?? error?.message ?? '')
              ? error.code ?? error.message
              : 'AGENT_LOCAL_CORE_FAILED',
          },
        }),
      )
  }
  const module = { exports: {} }
  const context = vm.createContext({ module, process: { parentPort }, AbortController, setTimeout, clearTimeout, console })
  const wrapper = vm.runInContext(`(function(require,module,process){\n${source}\nmodule.exports={dispatch};})`, context, { filename })
  wrapper(createRequire(filename), module, context.process)
  return module.exports.dispatch
}

async function makeFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-plan-execution-'))
  const projectsDirectory = path.join(directory, 'projects')
  const userDataDirectory = path.join(directory, 'user-data')
  await Promise.all([fs.mkdir(projectsDirectory), fs.mkdir(userDataDirectory)])
  const store = createLocalProjectStore()
  const projectResult = await store.createProject(projectsDirectory, '计划执行集成')
  const { project, directory: projectDirectory } = projectResult
  const runtime = {
    calls: [],
    loseGenerationResponseAfterCreate: 0,
    pauseNextGenerationResponseAfterCreate: null,
    pauseNextCreateNode: null,
    ...(options.runtime ?? {}),
  }
  const localModels = buildDesktopAgentModelDirectory(
    { apiKeyConfigured: false },
    { modelId: 'local-plan-test-model' },
    null,
  ).filter((model) => model.providerType === 'local' && model.modelType === 'text')

  async function localCoreRequest(method, payload) {
    runtime.calls.push({ method, payload: structuredClone(payload) })
    const { runId: _runId, ...coreInput } = payload
    switch (method) {
      case 'agent:core:load-canvas':
        return store.loadCanvas(payload.projectId, payload.canvasId)
      case 'agent:core:create-node':
        if (runtime.pauseNextCreateNode) {
          const gate = runtime.pauseNextCreateNode
          runtime.pauseNextCreateNode = null
          gate.markStarted()
          await gate.promise
        }
        return store.createNode(coreInput)
      case 'agent:core:update-node':
        return store.updateNode(coreInput)
      case 'agent:core:list-models':
        return localModels
      case 'agent:core:list-assets':
        return store.listAssets(payload.projectId)
      case 'agent:core:lookup-operation':
        return store.lookupAgentOperation(payload)
      case 'agent:core:create-generation-task': {
        const model = localModels.find((entry) => entry.name === payload.modelId
          && entry.providerId === payload.providerId && entry.providerType === payload.providerType
          && entry.modelType === payload.modality && entry.enabled)
        const canvas = await store.loadCanvas(payload.projectId, payload.canvasId)
        if (!model || canvas.version !== payload.canvasVersion
          || !canvas.nodes.some((node) => node.id === payload.nodeId && node.type === payload.modality)) {
          throw new Error('AGENT_GENERATION_MODEL_UNAVAILABLE')
        }
        const task = await store.createTask({
          ...coreInput,
          parameters: { ...(payload.parameters ?? {}), prompt: payload.prompt },
        })
        if (runtime.loseGenerationResponseAfterCreate > 0) {
          runtime.loseGenerationResponseAfterCreate -= 1
          throw new Error('AGENT_LOCAL_CORE_UNAVAILABLE')
        }
        if (runtime.pauseNextGenerationResponseAfterCreate) {
          const gate = runtime.pauseNextGenerationResponseAfterCreate
          runtime.pauseNextGenerationResponseAfterCreate = null
          gate.markStarted(task.taskId)
          await gate.promise
        }
        return task
      }
      case 'agent:core:delete-nodes':
        return deleteAgentNodes(payload, {
          loadCanvas: () => store.loadCanvas(payload.projectId, payload.canvasId),
          assertActive: async () => undefined,
          confirm: async () => true,
          deleteNode: async (input) => {
            const impact = await store.deleteNode(input)
            const canvas = await store.loadCanvas(input.projectId, input.canvasId)
            return { ...impact, version: canvas.version, canvas }
          },
          lookupDeletedNode: (input) => store.getDeletedNodeCommand(input),
        })
      case 'agent:core:get-task': {
        const task = await store.getTask(payload.projectId, payload.taskId)
        if (!task || task.status !== 'succeeded') return task
        try {
          await store.readTaskOutputText(payload.projectId, payload.taskId)
          return { ...task, outputVerified: true }
        } catch {
          return { ...task, outputVerified: false, errorCode: 'TASK_OUTPUT_UNAVAILABLE' }
        }
      }
      default:
        throw new Error('AGENT_LOCAL_CORE_METHOD_UNSUPPORTED')
    }
  }

  let dispatch = workerHarness(localCoreRequest)
  await dispatch('agent:open', { projectDirectory, userDataDirectory })
  const session = await dispatch('agent:create-session', {
    projectId: project.projectId,
    canvasId: project.canvasId,
    title: '计划执行集成会话',
  })
  t.after(async () => {
    try { await dispatch('agent:close') } catch {}
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  })

  return {
    project,
    projectDirectory,
    userDataDirectory,
    session,
    runtime,
    store,
    async restartWorker() {
      await dispatch('agent:close')
      dispatch = workerHarness(localCoreRequest)
      await dispatch('agent:open', { projectDirectory, userDataDirectory })
      return dispatch
    },
    dispatch(method, payload) { return dispatch(method, payload) },
  }
}

async function addTextNode(fixture, suffix, prompt = `seed-${suffix}`) {
  const canvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  const result = await fixture.store.createNode({
    projectId: fixture.project.projectId,
    canvasId: fixture.project.canvasId,
    idempotencyKey: `plan-execution-seed-${suffix}`,
    expectedVersion: canvas.version,
    type: 'text',
    prompt,
    params: { prompt },
  })
  return result.node.id
}

async function createPlan(fixture, steps) {
  const canvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  const id = String(nextPlanId++)
  const compiled = await fixture.dispatch('agent:plan:create', {
    projectId: fixture.project.projectId,
    id: fixture.session.sessionId,
    canvasId: fixture.project.canvasId,
    input: {
      profile: 'canvas-general',
      plan: { id, version: 1, canvasVersion: canvas.version, steps },
    },
  })
  return compiled.plan.id
}

function step(id, tool, dependsOn, input, extra = {}) {
  return { id, tool, input, inputHash: `hash-${id}`, dependsOn, estimatedCost: 0, ...extra }
}

async function executePlan(fixture, planId) {
  return fixture.dispatch('agent:plan:execute', {
    projectId: fixture.project.projectId,
    id: planId,
    canvasId: fixture.project.canvasId,
    input: { profile: 'canvas-general' },
  })
}

async function execution(fixture, planId) {
  const state = await fixture.dispatch('agent:plan:execution', { projectId: fixture.project.projectId, id: planId })
  // Keep the product execution DTO intact; obtain plan step state through its existing read API.
  return { ...state, plan: await plan(fixture, planId) }
}

async function plan(fixture, planId) {
  return fixture.dispatch('agent:plan:get', { projectId: fixture.project.projectId, id: planId })
}

async function sessionEvents(fixture) {
  return fixture.dispatch('agent:list-events', {
    projectId: fixture.project.projectId,
    sessionId: fixture.session.sessionId,
    afterSeq: 0,
  })
}

async function pendingConfirmation(fixture, kind = 'generation') {
  const events = await sessionEvents(fixture)
  const event = [...events].reverse().find((entry) => entry.type === 'confirmation_required'
    && entry.data?.kind === kind)
  assert.ok(event, `plan step must create the original desktop ${kind} confirmation`)
  assert.equal(typeof event.data.actionId, 'string')
  assert.equal(typeof event.data.approvalToken, 'string')
  return event.data
}

async function confirmGeneration(fixture, confirmation, accept = true) {
  const canvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  return fixture.dispatch('agent:confirm-action', {
    projectId: fixture.project.projectId,
    canvasId: fixture.project.canvasId,
    sessionId: fixture.session.sessionId,
    actionId: confirmation.actionId,
    approvalToken: confirmation.approvalToken,
    accept,
    currentCanvasVersion: canvas.version,
  })
}

async function confirmDeletion(fixture, confirmation, accept = true) {
  const canvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  return fixture.dispatch('agent:confirm-action', {
    projectId: fixture.project.projectId,
    canvasId: fixture.project.canvasId,
    sessionId: fixture.session.sessionId,
    actionId: confirmation.actionId,
    approvalToken: confirmation.approvalToken,
    accept,
    currentCanvasVersion: canvas.version,
  })
}

async function acceptedTaskIds(fixture, confirmation, result) {
  const fromResult = Array.isArray(result?.taskIds) ? result.taskIds : []
  const events = await sessionEvents(fixture)
  const fromEvents = events
    .filter((entry) => entry.type === 'task_status'
      && entry.data?.actionId === confirmation.actionId
      && entry.data?.actionStatus === 'accepted'
      && typeof entry.data?.task_id === 'string')
    .map((entry) => entry.data.task_id)
  return [...new Set([...fromResult, ...fromEvents])]
}

function stepStatus(executionResult, stepId) {
  return executionResult.plan.steps.find((entry) => entry.id === stepId)?.status
}

async function completeNextTextTask(fixture, options = {}) {
  const claim = await fixture.store.claimNextTask(fixture.project.projectId)
  assert.ok(claim, 'confirmed plan generation must be present in the real local TaskStore')
  assert.equal(claim.task.modality, 'text')
  return completeClaimedTextTask(fixture, claim, options)
}

async function completeClaimedTextTask(fixture, claim, options = {}) {
  assert.equal(claim.task.modality, 'text')
  const outputName = 'result.txt'
  const output = 'verified local TaskStore output\n'
  await fs.writeFile(path.join(claim.outputDirectory, outputName), output, 'utf8')
  const task = await fixture.store.recordTaskSucceeded(
    fixture.project.projectId,
    claim.task.taskId,
    `generated/${claim.task.taskId}/${outputName}`,
  )
  assert.equal(task.status, 'succeeded')
  assert.equal(await fixture.store.readTaskOutputText(fixture.project.projectId, claim.task.taskId), output)
  return options.withOutputPath
    ? { taskId: task.taskId, outputPath: path.join(claim.outputDirectory, outputName) }
    : task.taskId
}

async function failNextTextTask(fixture, errorCode = 'LOCAL_MODEL_FAILED') {
  const claim = await fixture.store.claimNextTask(fixture.project.projectId)
  assert.ok(claim, 'confirmed plan generation must be present in the real local TaskStore')
  assert.equal(claim.task.modality, 'text')
  const task = await fixture.store.recordTaskFailed(fixture.project.projectId, claim.task.taskId, errorCode)
  assert.equal(task.status, 'failed')
  return task.taskId
}

function createGate() {
  let markStarted
  let release
  const started = new Promise((resolve) => { markStarted = resolve })
  const promise = new Promise((resolve) => { release = resolve })
  return { started, promise, markStarted, release }
}

async function reconcileTasks(fixture) {
  return fixture.dispatch('agent:reconcile-tasks', { projectId: fixture.project.projectId, apiKey: '' })
}

test('plan execution reads, updates, confirms through the original flow, and advances after verified TaskStore output', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'single')
  const planId = await createPlan(fixture, [
    step('read', 'get_node_detail', [], { nodeId }),
    step('update', 'update_node_config', ['read'], { nodeId, config: { prompt: 'updated by plan' } }),
    step('generate', 'submit_generation', ['update'], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'write a local plan result' }, overwrite: false,
    }),
    step('downstream', 'get_node_detail', ['generate'], { nodeId }),
  ])

  const started = await executePlan(fixture, planId)
  assert.equal(started.state, 'waiting_confirmation')
  const repeated = await executePlan(fixture, planId)
  assert.equal(repeated.runId, started.runId)
  assert.equal(repeated.actionId, started.actionId)
  const beforeConfirmation = await execution(fixture, planId)
  assert.equal(stepStatus(beforeConfirmation, 'read'), 'completed')
  assert.equal(stepStatus(beforeConfirmation, 'update'), 'completed')
  assert.equal(stepStatus(beforeConfirmation, 'generate'), 'running')
  assert.equal(stepStatus(beforeConfirmation, 'downstream'), 'pending')
  const updatedCanvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  const updatedNode = updatedCanvas.nodes.find((node) => node.id === nodeId)
  assert.equal(updatedNode.data.prompt, 'updated by plan')

  const confirmation = await pendingConfirmation(fixture)
  const accepted = await confirmGeneration(fixture, confirmation)
  assert.equal(accepted.status, 'accepted')
  const repeatedAcceptance = await confirmGeneration(fixture, confirmation)
  assert.equal(repeatedAcceptance.status, 'accepted')
  const taskIds = await acceptedTaskIds(fixture, confirmation, accepted)
  assert.equal(taskIds.length, 1)
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 1)
  assert.equal((await fixture.store.getTask(fixture.project.projectId, taskIds[0])).status, 'queued')
  assert.equal((await execution(fixture, planId)).state, 'waiting_task')

  assert.equal(await completeNextTextTask(fixture), taskIds[0])
  const reconciled = await reconcileTasks(fixture)
  assert.equal(reconciled.scheduled, 0)
  const finished = await execution(fixture, planId)
  assert.equal(finished.state, 'completed')
  assert.equal(stepStatus(finished, 'generate'), 'completed')
  assert.equal(stepStatus(finished, 'downstream'), 'completed')
  const duplicateAfterCompletion = await confirmGeneration(fixture, confirmation)
  assert.equal(duplicateAfterCompletion.status, 'accepted')
  const afterDuplicateConfirmation = await execution(fixture, planId)
  assert.equal(afterDuplicateConfirmation.state, 'completed')
  assert.ok(afterDuplicateConfirmation.executions.every((entry) => entry.state === 'completed'))
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 1)
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 1)
})

test('batch plan execution waits for every confirmed task before releasing downstream steps', async (t) => {
  const fixture = await makeFixture(t)
  const firstNode = await addTextNode(fixture, 'batch-first')
  const secondNode = await addTextNode(fixture, 'batch-second')
  const planId = await createPlan(fixture, [
    step('batch', 'submit_generation_batch', [], {
      generations: [
        { nodeId: firstNode, modelType: 'local-plan-test-model', modelParams: { prompt: 'first batch result' }, overwrite: false },
        { nodeId: secondNode, modelType: 'local-plan-test-model', modelParams: { prompt: 'second batch result' }, overwrite: false },
      ],
    }, { batchSize: 2 }),
    step('downstream', 'update_node_config', ['batch'], {
      nodeId: firstNode, config: { prompt: 'batch barrier released' },
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  const accepted = await confirmGeneration(fixture, confirmation)
  const taskIds = await acceptedTaskIds(fixture, confirmation, accepted)
  assert.equal(taskIds.length, 2)
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 2)

  const firstTerminal = await completeNextTextTask(fixture)
  assert.ok(taskIds.includes(firstTerminal))
  await reconcileTasks(fixture)
  const oneOfTwo = await execution(fixture, planId)
  assert.equal(oneOfTwo.state, 'waiting_task')
  assert.equal(stepStatus(oneOfTwo, 'batch'), 'running')
  assert.equal(stepStatus(oneOfTwo, 'downstream'), 'pending')
  const beforeBarrierRelease = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.notEqual(beforeBarrierRelease.nodes.find((node) => node.id === firstNode).data.prompt, 'batch barrier released')

  const secondTerminal = await completeNextTextTask(fixture)
  assert.ok(taskIds.includes(secondTerminal))
  assert.notEqual(secondTerminal, firstTerminal)
  await reconcileTasks(fixture)
  const allTerminal = await execution(fixture, planId)
  assert.equal(allTerminal.state, 'completed')
  assert.equal(stepStatus(allTerminal, 'batch'), 'completed')
  assert.equal(stepStatus(allTerminal, 'downstream'), 'completed')
  const afterBarrierRelease = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.equal(afterBarrierRelease.nodes.find((node) => node.id === firstNode).data.prompt, 'batch barrier released')
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 2)
})

test('cancelling a waiting plan invalidates confirmation and creates no TaskStore entry', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'cancel-before-confirm')
  const planId = await createPlan(fixture, [
    step('generate', 'submit_generation', [], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'must not be submitted' }, overwrite: false,
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)

  const cancelled = await fixture.dispatch('agent:plan:cancel', { projectId: fixture.project.projectId, id: planId })
  assert.equal(cancelled.state, 'cancelled')
  await assert.rejects(confirmGeneration(fixture, confirmation), /CONFIRMATION_INVALIDATED/u)
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 0)
  assert.equal((await execution(fixture, planId)).state, 'cancelled')
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 0)
})

test('stopping after accepted generation leaves its task authoritative and prevents downstream writes', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'stop-after-confirm')
  const planId = await createPlan(fixture, [
    step('generate', 'submit_generation', [], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'confirmed task remains local' }, overwrite: false,
    }),
    step('downstream', 'update_node_config', ['generate'], {
      nodeId, config: { prompt: 'must not be written after stop' },
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  const accepted = await confirmGeneration(fixture, confirmation)
  const taskIds = await acceptedTaskIds(fixture, confirmation, accepted)
  assert.equal(taskIds.length, 1)
  const versionBeforeStop = (await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)).version

  const stopped = await fixture.dispatch('agent:plan:cancel', { projectId: fixture.project.projectId, id: planId })
  assert.equal(stopped.state, 'cancelled')
  assert.equal((await fixture.store.getTask(fixture.project.projectId, taskIds[0])).status, 'queued')
  assert.equal(await completeNextTextTask(fixture), taskIds[0])
  await reconcileTasks(fixture)
  const afterTerminal = await execution(fixture, planId)
  assert.equal(afterTerminal.state, 'cancelled')
  assert.equal(stepStatus(afterTerminal, 'downstream'), 'pending')
  const canvasAfterStop = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.equal(canvasAfterStop.version, versionBeforeStop)
  assert.equal(canvasAfterStop.nodes.find((node) => node.id === nodeId).data.prompt, 'seed-stop-after-confirm')
})

test('restart invalidates an unconfirmed plan action without submitting generation', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'restart-before-confirm')
  const planId = await createPlan(fixture, [
    step('generate', 'submit_generation', [], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'restart must not submit' }, overwrite: false,
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)

  await fixture.restartWorker()
  await assert.rejects(confirmGeneration(fixture, confirmation), /CONFIRMATION|RUN_NOT_ACTIVE/u)
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 0)
  assert.notEqual((await execution(fixture, planId)).state, 'waiting_confirmation')
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 0)
})

test('restart replays a confirmed task through the Local Tool Gateway ledger without duplication', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'restart-after-confirm')
  const planId = await createPlan(fixture, [
    step('generate', 'submit_generation', [], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'replay the durable task' }, overwrite: false,
    }),
    step('downstream', 'get_node_detail', ['generate'], { nodeId }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  fixture.runtime.loseGenerationResponseAfterCreate = 1
  await confirmGeneration(fixture, confirmation).then(
    () => assert.fail('lost Local Core response must surface to the confirming caller'),
    () => undefined,
  )
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 1)
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 1, JSON.stringify(fixture.runtime.calls))

  await fixture.restartWorker()
  const recovered = await execution(fixture, planId)
  assert.ok(['waiting_task', 'reconciliation_required'].includes(recovered.state))
  const replayed = await confirmGeneration(fixture, confirmation)
  assert.equal(replayed.status, 'accepted')
  const taskIds = await acceptedTaskIds(fixture, confirmation, replayed)
  assert.equal(taskIds.length, 1)
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 1)
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 1)

  assert.equal(await completeNextTextTask(fixture), taskIds[0])
  await reconcileTasks(fixture)
  const finished = await execution(fixture, planId)
  assert.equal(finished.state, 'completed')
  assert.equal(stepStatus(finished, 'downstream'), 'completed')
})

test('a batch with one failed task remains blocked until all siblings terminate, then blocks downstream work', async (t) => {
  const fixture = await makeFixture(t)
  const firstNode = await addTextNode(fixture, 'failed-batch-first')
  const secondNode = await addTextNode(fixture, 'failed-batch-second')
  const planId = await createPlan(fixture, [
    step('batch', 'submit_generation_batch', [], {
      generations: [
        { nodeId: firstNode, modelType: 'local-plan-test-model', modelParams: { prompt: 'one succeeds' }, overwrite: false },
        { nodeId: secondNode, modelType: 'local-plan-test-model', modelParams: { prompt: 'one fails' }, overwrite: false },
      ],
    }, { batchSize: 2 }),
    step('downstream', 'update_node_config', ['batch'], {
      nodeId: firstNode, config: { prompt: 'must remain blocked after batch failure' },
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  const accepted = await confirmGeneration(fixture, confirmation)
  const taskIds = await acceptedTaskIds(fixture, confirmation, accepted)
  assert.equal(taskIds.length, 2)

  const failedTaskId = await failNextTextTask(fixture)
  assert.ok(taskIds.includes(failedTaskId))
  await reconcileTasks(fixture)
  const siblingStillPending = await execution(fixture, planId)
  assert.equal(siblingStillPending.state, 'waiting_task')
  assert.equal(stepStatus(siblingStillPending, 'batch'), 'running')
  assert.equal(stepStatus(siblingStillPending, 'downstream'), 'pending')

  const succeededTaskId = await completeNextTextTask(fixture)
  assert.ok(taskIds.includes(succeededTaskId))
  assert.notEqual(succeededTaskId, failedTaskId)
  await reconcileTasks(fixture)
  const failedBatch = await execution(fixture, planId)
  assert.equal(failedBatch.state, 'failed')
  assert.equal(stepStatus(failedBatch, 'batch'), 'failed')
  assert.equal(stepStatus(failedBatch, 'downstream'), 'pending')
  const unchangedCanvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.notEqual(unchangedCanvas.nodes.find((node) => node.id === firstNode).data.prompt, 'must remain blocked after batch failure')
})

test('a succeeded TaskStore row without a readable output fails its plan step and blocks dependents', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'missing-output')
  const planId = await createPlan(fixture, [
    step('generate', 'submit_generation', [], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'output file must be verified' }, overwrite: false,
    }),
    step('downstream', 'update_node_config', ['generate'], {
      nodeId, config: { prompt: 'must not run without readable output' },
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  const accepted = await confirmGeneration(fixture, confirmation)
  const taskIds = await acceptedTaskIds(fixture, confirmation, accepted)
  assert.equal(taskIds.length, 1)

  const result = await completeNextTextTask(fixture, { withOutputPath: true })
  assert.equal(result.taskId, taskIds[0])
  await fs.rm(result.outputPath)
  assert.equal((await fixture.store.getTask(fixture.project.projectId, result.taskId)).status, 'succeeded')
  await reconcileTasks(fixture)
  const unavailable = await execution(fixture, planId)
  assert.equal(unavailable.state, 'failed')
  assert.equal(stepStatus(unavailable, 'generate'), 'failed')
  assert.equal(unavailable.plan.steps.find((entry) => entry.id === 'generate').lastError, 'TASK_OUTPUT_UNAVAILABLE')
  assert.equal(stepStatus(unavailable, 'downstream'), 'pending')
  const unchangedCanvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.equal(unchangedCanvas.nodes.find((node) => node.id === nodeId).data.prompt, 'seed-missing-output')
})

test('cancelling during an in-flight create_nodes batch lets one RPC return and blocks later batch writes', async (t) => {
  const fixture = await makeFixture(t)
  const gate = createGate()
  fixture.runtime.pauseNextCreateNode = gate
  const planId = await createPlan(fixture, [
    step('create', 'create_nodes', [], {
      nodes: [
        { type: 'text', prompt: 'already dispatched node', params: { prompt: 'already dispatched node' } },
        { type: 'text', prompt: 'must not dispatch after cancel', params: { prompt: 'must not dispatch after cancel' } },
      ],
    }),
    step('downstream', 'get_canvas_summary', ['create'], {}),
  ])

  const running = executePlan(fixture, planId)
  await gate.started
  const cancelled = await fixture.dispatch('agent:plan:cancel', { projectId: fixture.project.projectId, id: planId })
  assert.equal(cancelled.state, 'cancelled')
  gate.release()
  const runResult = await running
  assert.equal(runResult.state, 'cancelled')

  const canvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.equal(canvas.nodes.length, 1, 'the already dispatched local write may complete')
  assert.equal(canvas.nodes[0].data.prompt, 'already dispatched node')
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-node').length, 1)
  const stopped = await execution(fixture, planId)
  assert.equal(stopped.state, 'cancelled')
  assert.equal(stepStatus(stopped, 'downstream'), 'pending')
})

test('archiving a session during an accepted plan task reconciles its terminal result without advancing the plan', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'archive-running-task')
  const planId = await createPlan(fixture, [
    step('generate', 'submit_generation', [], {
      nodeId, modelType: 'local-plan-test-model', modelParams: { prompt: 'accepted before archive' }, overwrite: false,
    }),
    step('downstream', 'update_node_config', ['generate'], {
      nodeId, config: { prompt: 'must remain blocked after archive' },
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  const accepted = await confirmGeneration(fixture, confirmation)
  assert.equal(accepted.status, 'accepted')
  const taskIds = await acceptedTaskIds(fixture, confirmation, accepted)
  assert.equal(taskIds.length, 1)
  const claim = await fixture.store.claimNextTask(fixture.project.projectId)
  assert.ok(claim)
  assert.equal(claim.task.taskId, taskIds[0])
  assert.equal(claim.task.status, 'running')

  const archived = await fixture.dispatch('agent:update-session', {
    projectId: fixture.project.projectId,
    sessionId: fixture.session.sessionId,
    input: { status: 'archived' },
  })
  assert.equal(archived.status, 'archived')
  assert.equal((await execution(fixture, planId)).state, 'cancelled')

  await completeClaimedTextTask(fixture, claim)
  await reconcileTasks(fixture)
  const reconciled = await execution(fixture, planId)
  assert.equal(reconciled.state, 'cancelled')
  assert.equal(stepStatus(reconciled, 'downstream'), 'pending')
  const canvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.equal(canvas.nodes.find((node) => node.id === nodeId).data.prompt, 'seed-archive-running-task')
  assert.equal((await fixture.store.getTask(fixture.project.projectId, taskIds[0])).status, 'succeeded')
})

test('cancelling during the first confirmed batch RPC links its committed task and prevents the second RPC', async (t) => {
  const fixture = await makeFixture(t)
  const gate = createGate()
  fixture.runtime.pauseNextGenerationResponseAfterCreate = gate
  const firstNode = await addTextNode(fixture, 'cancel-batch-first')
  const secondNode = await addTextNode(fixture, 'cancel-batch-second')
  const planId = await createPlan(fixture, [
    step('batch', 'submit_generation_batch', [], {
      generations: [
        { nodeId: firstNode, modelType: 'local-plan-test-model', modelParams: { prompt: 'first already committed' }, overwrite: false },
        { nodeId: secondNode, modelType: 'local-plan-test-model', modelParams: { prompt: 'second must not dispatch' }, overwrite: false },
      ],
    }, { batchSize: 2 }),
    step('downstream', 'update_node_config', ['batch'], {
      nodeId: firstNode, config: { prompt: 'must remain blocked after cancel' },
    }),
  ])
  assert.equal((await executePlan(fixture, planId)).state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture)
  const confirming = confirmGeneration(fixture, confirmation).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  const firstTaskId = await gate.started
  assert.equal((await fixture.store.listTasks(fixture.project.projectId)).length, 1)
  assert.equal((await fixture.store.getTask(fixture.project.projectId, firstTaskId)).status, 'queued')

  const cancelled = await fixture.dispatch('agent:plan:cancel', { projectId: fixture.project.projectId, id: planId })
  assert.equal(cancelled.state, 'cancelled')
  gate.release()
  const confirmationOutcome = await confirming
  assert.match(confirmationOutcome.error?.message ?? '', /PLAN_CANCELLED/u)

  const taskRows = await fixture.store.listTasks(fixture.project.projectId)
  assert.equal(taskRows.length, 1)
  assert.equal(taskRows[0].taskId, firstTaskId)
  const stopped = await execution(fixture, planId)
  assert.equal(stopped.state, 'cancelled')
  assert.deepEqual(stopped.taskIds, [firstTaskId])
  assert.equal(stepStatus(stopped, 'downstream'), 'pending')
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:create-generation-task').length, 1)

  assert.equal(await completeNextTextTask(fixture), firstTaskId)
  await reconcileTasks(fixture)
  const terminal = await execution(fixture, planId)
  assert.equal(terminal.state, 'cancelled')
  assert.equal(stepStatus(terminal, 'downstream'), 'pending')
})

test('confirmed plan deletion uses the original delete confirmation and releases dependent reads', async (t) => {
  const fixture = await makeFixture(t)
  const nodeId = await addTextNode(fixture, 'plan-delete')
  const initialCanvas = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  const planId = await createPlan(fixture, [
    step('delete', 'delete_nodes', [], { nodeIds: [nodeId] }),
    step('downstream', 'get_canvas_summary', ['delete'], {}),
  ])

  const started = await executePlan(fixture, planId)
  assert.equal(started.state, 'waiting_confirmation')
  const confirmation = await pendingConfirmation(fixture, 'canvas_delete')
  const beforeConfirmation = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.ok(beforeConfirmation.nodes.some((node) => node.id === nodeId))
  assert.equal(beforeConfirmation.version, initialCanvas.version)

  const accepted = await confirmDeletion(fixture, confirmation)
  assert.equal(accepted.status, 'accepted')
  const afterConfirmation = await fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId)
  assert.equal(afterConfirmation.nodes.some((node) => node.id === nodeId), false)
  assert.equal(afterConfirmation.version, initialCanvas.version + 1)
  const finished = await execution(fixture, planId)
  assert.equal(finished.state, 'completed')
  assert.equal(stepStatus(finished, 'delete'), 'completed')
  assert.equal(stepStatus(finished, 'downstream'), 'completed')
  assert.equal(fixture.runtime.calls.filter((call) => call.method === 'agent:core:delete-nodes').length, 1)
})
