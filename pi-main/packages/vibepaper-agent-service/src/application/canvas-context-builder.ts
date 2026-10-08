import { type ContextBudget, truncateToBudget } from "../domain/context-budget.ts";

export type CanvasNodeRecord = { id: string; type: string; data: Record<string, unknown> };
export type CanvasEdgeRecord = { source: string; target: string };
export type CanvasAssetRecord = { id: string; name: string; url?: string; [key: string]: unknown };

export type CanvasContextInput = {
	authorized: boolean;
	version: number;
	summary: string;
	nodes: readonly CanvasNodeRecord[];
	edges: readonly CanvasEdgeRecord[];
	assets: readonly CanvasAssetRecord[];
	selectedNodeIds: readonly string[];
};

export type CanvasContext = {
	summary: string;
	selectedNodes: readonly CanvasNodeRecord[];
	oneHopDependencies: readonly CanvasNodeRecord[];
	relevantAssets: readonly CanvasAssetRecord[];
	version: number;
};

export function buildCanvasContext(
	input: CanvasContextInput,
	budget: ContextBudget = { maxCharacters: 12_000 },
): CanvasContext {
	if (!input.authorized) throw new Error("PERMISSION_DENIED");
	const selectedIds = new Set(input.selectedNodeIds);
	const selectedNodes = input.nodes.filter((node) => selectedIds.has(node.id)).map(sanitizeNode);
	const dependencyIds = new Set(
		input.edges.flatMap((edge) =>
			selectedIds.has(edge.source) ? [edge.target] : selectedIds.has(edge.target) ? [edge.source] : [],
		),
	);
	const oneHopDependencies = input.nodes
		.filter((node) => dependencyIds.has(node.id) && !selectedIds.has(node.id))
		.map(sanitizeNode);
	return {
		summary: truncateToBudget(input.summary, budget.maxCharacters),
		selectedNodes,
		oneHopDependencies,
		relevantAssets: input.assets.map(sanitizeAsset),
		version: input.version,
	};
}

function sanitizeNode(node: CanvasNodeRecord): CanvasNodeRecord {
	return { ...node, data: sanitizeRecord(node.data) };
}

function sanitizeAsset(asset: CanvasAssetRecord): CanvasAssetRecord {
	return sanitizeRecord(asset) as CanvasAssetRecord;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record)
			.filter(([key]) => !/(secret|token|password|api[_-]?key|authorization|binary|data[_-]?url|base64)/i.test(key))
			.map(([key, value]) => [key, sanitizeValue(value)]),
	);
}

function sanitizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeValue);
	if (typeof value === "object" && value !== null) return sanitizeRecord(value as Record<string, unknown>);
	return value;
}
