import { describe, expect, it } from 'vitest'
import { cameraAt, readCreativeCamera, readCreativeMotion, readCreativeScene } from './creativePluginRuntime'
import { readFileSync } from 'node:fs'

const fixture = new URL('../../../../marketplace/packages/interview-two-camera-1.0.0.json', import.meta.url)
const interview: { components: { id: string; data: unknown }[] } = JSON.parse(readFileSync(fixture, 'utf8'))

const component = (id: string) => {
  const item = interview.components.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`Missing component: ${id}`)
  return item.data
}

describe('online interview director bundle', () => {
  it('loads editable scene objects and applies distinct left and right camera settings', () => {
    const source = component('interview-stage')
    const scene = readCreativeScene(source)
    expect(scene.objects.filter((object) => object.category === 'character').map((object) => object.name)).toEqual(['采访者', '受访者'])
    expect(scene.objects.filter((object) => object.kind === '椅子')).toHaveLength(2)
    expect(scene.objects.find((object) => object.name === '采访者')?.position[0]).toBeLessThan(0)
    expect(scene.objects.find((object) => object.name === '受访者')?.position[0]).toBeGreaterThan(0)
    const left = readCreativeCamera(component('left-view'))
    const right = readCreativeCamera(component('right-view'))
    expect(left.yaw).toBeLessThan(0)
    expect(right.yaw).toBeGreaterThan(0)
    expect(left.pitch).toBe(right.pitch)
    expect(left.distance).toBe(right.distance)
    scene.objects[0].name = '本地编辑'
    expect(readCreativeScene(source).objects[0].name).toBe('采访者')
  })

  it('uses the actual motion component for the editor preview and finishes at the right view', () => {
    const motion = readCreativeMotion(component('orbit-between-views'))
    expect(motion.from).toEqual(readCreativeCamera(component('left-view')))
    expect(motion.to).toEqual(readCreativeCamera(component('right-view')))
    expect(motion.duration).toBe(6)
    expect(cameraAt(motion, 0)).toEqual(motion.from)
    expect(cameraAt(motion, 0.5)).toEqual({ yaw: 0, pitch: 20, distance: 8.5 })
    expect(cameraAt(motion, 1)).toEqual(motion.to)
  })
})
