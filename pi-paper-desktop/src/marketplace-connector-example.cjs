// Declarative recipes only. Installation never starts a process or creates an MCP grant.
module.exports = {
  schemaVersion: 1,
  id: 'vibepaper-connectors',
  version: '1.0.0',
  name: 'MCP 与本地工具连接',
  description: '为外部 Agent 预填授权范围，或手动选择本机 MCP 文本工具。',
  author: 'Pi-Paper',
  components: [
    {
      id: 'codex-canvas', type: 'connector', name: 'Codex 画布连接',
      description: '在原 MCP 设置页预填 Codex 的画布读写范围；需要用户检查并创建授权。',
      data: { kind: 'mcp-client', clientName: 'codex', permissions: ['canvas.read', 'canvas.write'] },
    },
    {
      id: 'local-text-tool', type: 'connector', name: '本地 MCP 文本工具',
      description: '选择本机可执行的 MCP 服务和一个文本工具，手动发送文本并查看结果。',
      data: { kind: 'local-mcp', capability: 'text-transform' },
    },
  ],
}
