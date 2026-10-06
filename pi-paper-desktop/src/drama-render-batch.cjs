function dramaRenderTaskIdempotencyKey(batchId, jobId, attempt) {
  if (typeof batchId !== 'string' || !batchId || typeof jobId !== 'string' || !jobId
    || !Number.isSafeInteger(attempt) || attempt < 0) {
    throw Object.assign(new Error('已确认的镜头任务内容无效。'), { code: 'CONFIRMATION_INVALID' })
  }
  return `drama-batch:${batchId}:job:${jobId}:attempt:${attempt}`
}

function createDramaBatchTaskInput({ projectId, canvasId, batchId, canvasVersion, job }) {
  if (!job || typeof job !== 'object' || typeof job.canvasNodeId !== 'string' || !job.canvasNodeId
    || typeof job.keyframeRenderId !== 'string' || !job.keyframeRenderId
    || typeof job.modelParams?.prompt !== 'string' || typeof job.providerType !== 'string'
    || typeof job.providerId !== 'string' || typeof job.modelId !== 'string') {
    throw Object.assign(new Error('已确认的镜头任务内容无效。'), { code: 'CONFIRMATION_INVALID' })
  }
  const idempotencyKey = dramaRenderTaskIdempotencyKey(batchId, job.id, job.attempt)
  const parameters = { ...(job.modelParams ?? {}) }
  // TaskStore's URI resolver validates project ownership and the successful image output
  // before any provider request receives the keyframe.
  parameters.firstFrameUrl = `vibe://app/tasks/${job.keyframeRenderId}/output`
  return {
    projectId,
    canvasId,
    canvasVersion,
    nodeId: job.canvasNodeId,
    modality: 'video',
    providerType: job.providerType,
    providerId: job.providerId,
    modelId: job.modelId,
    prompt: job.modelParams.prompt,
    parameters,
    idempotencyKey,
  }
}

module.exports = { createDramaBatchTaskInput, dramaRenderTaskIdempotencyKey }
