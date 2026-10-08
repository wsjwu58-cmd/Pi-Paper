/**
 * Simple canvas-fact questions do not need model planning.  Answering these
 * deterministically avoids a tool-only model turn that can otherwise finish
 * without any user-facing text.
 */
export function isNodeCountQuestion(content: string): boolean {
	const normalized = content.trim().toLocaleLowerCase("zh-CN");
	if (!/(节点|node)/i.test(normalized)) return false;
	return /(多少|几个|几条|数量|总数|一共|共有|总共有)/.test(normalized);
}

export function nodeCountFromCanvasSummary(summary: Record<string, unknown>): number | undefined {
	return Array.isArray(summary.nodes) ? summary.nodes.length : undefined;
}

export function nodeCountReply(count: number): string {
	return `当前画布共有 ${count} 个节点。`;
}

/** A terminal response is required even when an upstream model ends after tool calls only. */
export function missingAssistantReply(content: string): string {
	if (isNodeCountQuestion(content)) return "我已读取画布信息，但暂时无法确认节点总数，请稍后重试。";
	return "我已完成必要的信息读取，但未能生成完整答复。请再试一次。";
}
