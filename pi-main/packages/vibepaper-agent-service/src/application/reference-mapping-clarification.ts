export const REFERENCE_MAPPING_ERROR = "选中了多个参考节点，但目标没有明确的来源。";

export interface ReferenceMappingEvent {
	type: string;
	toolName?: string;
	ok?: boolean;
	errorCode?: string;
	details?: unknown;
}

export function referenceMappingClarification(
	events: readonly ReferenceMappingEvent[],
	assistantText: string,
): string | undefined {
	let mappingUnresolved = false;
	for (const event of events) {
		if (event.type !== "tool" || event.toolName !== "create_nodes") continue;
		if (event.ok) {
			mappingUnresolved = false;
			continue;
		}
		if (event.errorCode !== "INVALID_INPUT") continue;
		const content = (event.details as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) continue;
		const hasMappingError = content.some(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as { text?: unknown }).text === "string" &&
				(item as { text: string }).text.includes(REFERENCE_MAPPING_ERROR),
		);
		if (hasMappingError) mappingUnresolved = true;
	}
	if (!mappingUnresolved || (/[?？]/.test(assistantText) && /对应|哪张|哪个镜头/.test(assistantText)))
		return undefined;
	return "我还不能确定这些分镜图片分别对应哪个视频镜头。请告诉我每张图片对应的镜头，确认后我再修改画布。";
}
