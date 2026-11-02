// A wholly local, declarative creative bundle. Installation performs no action.
module.exports = {
  schemaVersion: 1, id: 'creative-studio', version: '1.0.0', name: '创作工作室',
  description: '可编辑的导演场景、机位、运镜、商品海报和分镜导出', author: 'VibePaper',
  components: [
    { id: 'product-stage', type: 'director_scene', name: '商品棚拍场景', description: '在导演台追加桌面和灯光，可继续调整对象', data: { objects: [
      { category: 'prop', kind: '桌子', name: '展示桌', position: [0, 0, 0], rotation: 0, scale: 1, color: '#8b6914' },
      { category: 'prop', kind: '灯', name: '侧光', position: [-2, 0, 1], rotation: 25, scale: 1, color: '#f5d76e' },
    ], camera: { yaw: 35, pitch: 25, distance: 8 } } },
    { id: 'product-angle', type: 'director_camera', name: '商品三分之四机位', description: '在导演台应用可调机位', data: { yaw: 35, pitch: 25, distance: 8 } },
    { id: 'push-in', type: 'director_motion', name: '缓慢推近', description: '可修改起点、终点和时长并预览播放', data: { from: { yaw: 35, pitch: 25, distance: 12 }, to: { yaw: 35, pitch: 25, distance: 5 }, duration: 4 } },
    { id: 'product-poster', type: 'poster_layout', name: '商品标题海报', description: '以选中图片创作海报并输出 PNG 到画布', data: { width: 1080, height: 1350, background: '#f3f0ea', image: { x: 80, y: 80, width: 920, height: 960, fit: 'contain' }, title: { text: '商品名称', x: 100, y: 1190, size: 72, color: '#252525' } } },
    { id: 'horizontal', type: 'selection_command', name: '横向排列', description: '排列当前选中的画布节点', data: { command: 'arrange', orientation: 'horizontal', gap: 28 } },
    { id: 'shots', type: 'storyboard', name: '分镜表', description: '调整选中节点顺序和字段后导出 CSV', data: { fields: ['title', 'type', 'prompt', 'camera', 'content'] } },
    { id: 'four-crop', type: 'media_tool', name: '四宫格裁剪', description: '打开图片节点的本地裁剪编辑器', data: { tool: 'crop', mode: 'four' } },
  ],
}
