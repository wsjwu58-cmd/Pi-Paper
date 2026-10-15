import { describe, expect, it } from 'vitest'
import { filterSkillCommandItems } from './skillCommandPickerUtils'

const skills = [
  { id: '1', name: '产品视觉', description: '商业视觉', instructions: '图片', source: 'manual', version: 1 },
  { id: '4', name: '产品视觉', description: '重复名称', instructions: '图片', source: 'manual', version: 1 },
  { id: '2', name: '镜头级分镜', description: '视频镜头', instructions: '视频', source: 'system_dynamic', version: 1 },
  { id: '3', name: 'paper-agent-default', description: '默认', instructions: '默认', source: 'builtin', version: 1 },
] as const

describe('skill command picker', () => {
  it('filters by name or description and hides the internal default skill', () => {
    expect(filterSkillCommandItems(skills, '视频').map((skill) => skill.name)).toEqual(['镜头级分镜'])
    expect(filterSkillCommandItems(skills, '重复').map((skill) => skill.name)).toEqual(['产品视觉'])
    expect(filterSkillCommandItems(skills, '').map((skill) => skill.name)).toEqual(['产品视觉', '镜头级分镜'])
  })
})
