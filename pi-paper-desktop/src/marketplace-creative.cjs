// Declarative creative components. These values describe existing editor actions;
// they never contain executable code, file paths, credentials, or media references.
const CREATIVE_TYPES = new Set(['director_scene', 'director_camera', 'director_motion', 'poster_layout', 'selection_command', 'storyboard', 'media_tool'])
const bad = () => { throw new Error('MARKETPLACE_PACKAGE_INVALID') }
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
function keys(v, allowed) {
  if (!record(v) || Object.keys(v).some((key) => !allowed.includes(key))) bad()
}
function number(v, min, max) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad() }
function text(v, max) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /(?:https?|file|vibe):\/\/|(?:[a-z]:\\|\/(?:Users|home|private|tmp)\/)/iu.test(v)) bad()
}
function color(v) { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/iu.test(v)) bad() }
function camera(v) {
  keys(v, ['yaw', 'pitch', 'distance'])
  number(v.yaw, -180, 180); number(v.pitch, 5, 80); number(v.distance, 3, 20)
}
const kinds = {
  character: ['站立', '行走', '奔跑', '坐', '挥手', '跳跃', '点头', '摇头', '沮丧', '潜行', '儿童'],
  prop: ['台阶', '椅子', '墙板', '灯', '拱门', '树', '桌子', '栅栏'],
  primitive: ['方块', '球体', '圆柱', '圆锥', '金字塔', '胶囊', '圆环'],
}
function validateCreativeData(type, data) {
  if (!CREATIVE_TYPES.has(type)) bad()
  if (type === 'director_camera') camera(data)
  if (type === 'director_motion') {
    keys(data, ['from', 'to', 'duration']); camera(data.from); camera(data.to); number(data.duration, 0.5, 30)
  }
  if (type === 'director_scene') {
    keys(data, ['objects', 'camera']); camera(data.camera)
    if (!Array.isArray(data.objects) || data.objects.length < 1 || data.objects.length > 50) bad()
    for (const object of data.objects) {
      keys(object, ['category', 'kind', 'name', 'position', 'rotation', 'scale', 'color'])
      if (!Object.hasOwn(kinds, object.category) || !kinds[object.category].includes(object.kind)) bad()
      text(object.name, 64)
      if (!Array.isArray(object.position) || object.position.length !== 3) bad()
      number(object.position[0], -6, 6); number(object.position[1], -1, 4); number(object.position[2], -6, 6)
      number(object.rotation, -180, 180); number(object.scale, 0.3, 3); color(object.color)
    }
  }
  if (type === 'poster_layout') {
    keys(data, ['width', 'height', 'background', 'image', 'title'])
    number(data.width, 128, 4096); number(data.height, 128, 4096)
    if (!Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width * data.height > 16_000_000) bad()
    color(data.background); keys(data.image, ['x', 'y', 'width', 'height', 'fit'])
    number(data.image.x, 0, data.width - 1); number(data.image.y, 0, data.height - 1)
    number(data.image.width, 1, data.width - data.image.x); number(data.image.height, 1, data.height - data.image.y)
    if (!['cover', 'contain'].includes(data.image.fit)) bad()
    keys(data.title, ['text', 'x', 'y', 'size', 'color']); text(data.title.text, 200)
    number(data.title.x, 0, data.width); number(data.title.y, 0, data.height); number(data.title.size, 8, 512); color(data.title.color)
  }
  if (type === 'selection_command') {
    keys(data, ['command', 'orientation', 'gap'])
    if (data.command !== 'arrange' || !['horizontal', 'vertical'].includes(data.orientation)) bad()
    number(data.gap, 0, 500)
  }
  if (type === 'storyboard') {
    keys(data, ['fields'])
    const allowed = ['title', 'type', 'prompt', 'camera', 'content']
    if (!Array.isArray(data.fields) || !data.fields.length || data.fields.length > allowed.length || new Set(data.fields).size !== data.fields.length || data.fields.some((field) => !allowed.includes(field))) bad()
  }
  if (type === 'media_tool') {
    keys(data, ['tool', 'mode'])
    if (data.tool !== 'crop' || !['single', 'four', 'nine'].includes(data.mode)) bad()
  }
  return data
}
module.exports = { CREATIVE_TYPES, validateCreativeData }
