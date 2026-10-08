import { createHash } from "node:crypto";

export type RenderInput = {
	canonRevision: number;
	characterLookRevision: number;
	promptRevision: number;
	canvasVersion: number;
	lineageInputs: readonly string[];
};

export type LineageDependency = { lineageId: string; shotId: string; characterIds: readonly string[] };

export function buildRenderInputHash(input: RenderInput): string {
	return createHash("sha256")
		.update(JSON.stringify({ ...input, lineageInputs: [...input.lineageInputs].sort() }), "utf8")
		.digest("hex");
}

export function computeLineageImpact(
	lineages: readonly LineageDependency[],
	change: { changedCharacterId?: string; changedShotId?: string },
): readonly string[] {
	return lineages
		.filter(
			(lineage) =>
				(change.changedShotId !== undefined && lineage.shotId === change.changedShotId) ||
				(change.changedCharacterId !== undefined && lineage.characterIds.includes(change.changedCharacterId)),
		)
		.map((lineage) => lineage.lineageId);
}
