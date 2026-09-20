import type { MemoryScope } from "../domain/memory.ts";

export type ExtractedMemoryCandidate = {
	content: string;
	scope: Exclude<MemoryScope, "session" | "enterprise">;
	memoryType: "preference" | "project_rule";
	confidence: number;
	explicit: boolean;
};

const MEMORY_PREFIX = /^(?:请|麻烦)?(?:记住|记下|牢记|以后记得|以后都要|默认使用|默认采用|我偏好|我喜欢|我习惯)\s*[:：,，]?\s*(.+)$/u;
const ENGLISH_MEMORY_PREFIX = /^(?:please\s+)?(?:remember|always use|my preference is|i prefer)\s*[:：,，]?\s*(.+)$/iu;

/**
 * Extract only explicit, stable preference/rule statements. Generated content,
 * task results and ordinary conversation deliberately return no candidates.
 */
export function extractMemoryCandidates(content: string): readonly ExtractedMemoryCandidate[] {
	const normalized = content.trim();
	if (!normalized || normalized.length > 1_000) return [];
	const match = normalized.match(MEMORY_PREFIX) ?? normalized.match(ENGLISH_MEMORY_PREFIX);
	if (!match?.[1]) return [];
	const value = match[1].trim().replace(/[。.!！]+$/u, "");
	if (value.length < 2 || value.length > 500) return [];
	const projectScoped = /(?:这个画布|本项目|当前项目|该项目|this canvas|this project)/iu.test(normalized);
	return [
		{
			content: value,
			scope: projectScoped ? "canvas" : "long_term",
			memoryType: projectScoped ? "project_rule" : "preference",
			confidence: 0.95,
			explicit: true,
		},
	];
}
