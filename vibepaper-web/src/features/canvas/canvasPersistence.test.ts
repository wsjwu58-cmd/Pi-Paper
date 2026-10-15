import { describe, expect, it } from 'vitest'
import { createMcpCanvasFlushResponse, isFinalMcpCanvasImeInput, settleMcpCanvasFlushRequest, shouldBlockMcpCanvasInput } from './canvasPersistence'

const activePointerIds = new Set([7])

describe('MCP canvas save barrier', () => {
  it('leaves normal canvas interaction and unrelated events alone while idle', () => {
    expect(shouldBlockMcpCanvasInput({ phase: 'idle', eventType: 'pointerdown', activePointerIds, composing: false })).toBe(false)
    expect(shouldBlockMcpCanvasInput({ phase: 'active', eventType: 'vp-agent-executed', activePointerIds, composing: false })).toBe(false)
  })

  it('blocks new edits while a requested barrier waits for an existing drag to finish', () => {
    for (const eventType of ['pointerdown', 'keydown', 'beforeinput', 'paste', 'drop', 'dragstart', 'click']) {
      expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType, activePointerIds, composing: false })).toBe(true)
    }
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'pointermove', pointerId: 7, activePointerIds, composing: false })).toBe(false)
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'pointerup', pointerId: 7, activePointerIds, composing: false })).toBe(false)
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'pointermove', pointerId: 8, activePointerIds, composing: false })).toBe(true)
  })

  it('lets an in-progress IME composition commit, then blocks the rest of the canvas input', () => {
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'compositionupdate', activePointerIds, composing: true })).toBe(false)
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'compositionend', activePointerIds, composing: true })).toBe(false)
    // Chromium may deliver the compositionend event before its final
    // beforeinput/input pair; the page keeps the composing flag through that
    // commit turn and only then lets the flush proceed.
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'beforeinput', activePointerIds, composing: true })).toBe(false)
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'input', activePointerIds, composing: true })).toBe(false)
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'compositionstart', activePointerIds, composing: false })).toBe(true)
    expect(shouldBlockMcpCanvasInput({ phase: 'pending', eventType: 'beforeinput', activePointerIds, composing: false })).toBe(true)
    expect(shouldBlockMcpCanvasInput({ phase: 'active', eventType: 'input', activePointerIds, composing: true })).toBe(true)
    expect(shouldBlockMcpCanvasInput({ phase: 'active', eventType: 'pointermove', pointerId: 7, activePointerIds, composing: false })).toBe(true)
  })

  it('waits through compositionend and beforeinput until the browser commits the final input event', () => {
    const afterCompositionEnd = true
    expect(isFinalMcpCanvasImeInput({
      afterCompositionEnd,
      eventType: 'beforeinput',
      isComposing: false,
      inputType: 'insertText',
    })).toBe(false)
    expect(isFinalMcpCanvasImeInput({
      afterCompositionEnd,
      eventType: 'input',
      isComposing: true,
      inputType: 'insertCompositionText',
    })).toBe(false)
    expect(isFinalMcpCanvasImeInput({
      afterCompositionEnd,
      eventType: 'input',
      isComposing: false,
      inputType: 'insertFromComposition',
    })).toBe(true)
    expect(isFinalMcpCanvasImeInput({
      afterCompositionEnd,
      eventType: 'input',
      isComposing: false,
      inputType: 'insertText',
    })).toBe(true)
  })

  it('acknowledges the exact requested scope and persisted version, or a safe failure code', () => {
    const request = { requestId: 'flush-1', projectId: 'project-1', canvasId: 'canvas-1', expectedVersion: 4 }
    expect(createMcpCanvasFlushResponse(request, { status: 'flushed', persistedVersion: 5 })).toEqual({
      requestId: 'flush-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'flushed', persistedVersion: 5,
    })
    expect(createMcpCanvasFlushResponse(request, { status: 'failed', errorCode: 'CANVAS_SAVE_FAILED' })).toEqual({
      requestId: 'flush-1', projectId: 'project-1', canvasId: 'canvas-1', status: 'failed', errorCode: 'CANVAS_SAVE_FAILED',
    })
  })

  it('settles only the matching request id and canvas scope when flush requests overlap', () => {
    const requestA = { requestId: 'flush-a', projectId: 'project-1', canvasId: 'canvas-1', expectedVersion: 4 }
    const requestB = { requestId: 'flush-b', projectId: 'project-1', canvasId: 'canvas-1', expectedVersion: 4 }
    const requests = new Map([
      [requestA.requestId, requestA],
      [requestB.requestId, requestB],
    ])

    expect(settleMcpCanvasFlushRequest(requests, { requestId: 'flush-b', projectId: 'project-2', canvasId: 'canvas-1' })).toBe(false)
    expect(requests.size).toBe(2)
    expect(settleMcpCanvasFlushRequest(requests, { requestId: 'flush-a', projectId: 'project-1', canvasId: 'canvas-1' })).toBe(true)
    expect(requests.has('flush-a')).toBe(false)
    expect(requests.has('flush-b')).toBe(true)
  })
})
