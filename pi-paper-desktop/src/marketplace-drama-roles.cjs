// A local work package; choosing a role or installing a component runs nothing.
module.exports = {
  schemaVersion: 1, id: 'short-drama-workbench', version: '1.0.0', name: '短剧工作包',
  description: '按需选装分镜导演、审片员与分镜表。', author: 'Pi-Paper',
  components: [
    { id: 'shot-preparation', type: 'workflow_recipe', name: '镜头准备', description: '检查提示词、预览排列与分镜表。', data: { steps: [
      { kind: 'check_missing_prompt', componentId: 'storyboard' }, { kind: 'arrange', componentId: 'shot-order' },
      { kind: 'storyboard_preview', componentId: 'storyboard' },
    ] } },
    { id: 'storyboard-director', type: 'agent_role', name: '分镜导演', description: '组织镜头与可编辑画布，不自动生成。', data: {
      profile: 'vertical-short-drama',
      tools: ['get_canvas_summary', 'get_selected_nodes', 'get_node_detail', 'check_task_status', 'create_nodes', 'connect_nodes', 'layout_nodes', 'update_node_config', 'load_skill', 'marketplace_inspect', 'marketplace_commands', 'marketplace_preview', 'marketplace_command_apply', 'marketplace_command_undo'],
      skills: ['shot-storyboard'], contexts: ['canvas', 'selection', 'history'],
      instructions: '先核对现有画布和用户选区，再组织镜头顺序、画面要求与独立可编辑节点。缺少依据时询问；不要提交生成。',
    } },
    { id: 'shot-reviewer', type: 'agent_role', name: '审片员', description: '只读检查镜头和选区，列出可核对的问题。', data: {
      profile: 'audit-readonly',
      tools: ['get_canvas_summary', 'get_selected_nodes', 'get_node_detail', 'check_task_status', 'marketplace_inspect', 'marketplace_commands', 'marketplace_preview'],
      skills: [], contexts: ['canvas', 'selection', 'history'],
      instructions: '只检查已有镜头的顺序、一致性和信息缺口，逐项说明证据及建议，不修改画布。',
    } },
    { id: 'storyboard', type: 'storyboard', name: '分镜表', description: '整理所选镜头并预览、导出分镜表。',
      data: { fields: ['title', 'type', 'prompt', 'camera', 'content'] } },
    { id: 'shot-order', type: 'selection_command', name: '纵向镜头排列', description: '将选中镜头纵向排列。',
      data: { command: 'arrange', orientation: 'vertical', gap: 28 } },
  ],
}
