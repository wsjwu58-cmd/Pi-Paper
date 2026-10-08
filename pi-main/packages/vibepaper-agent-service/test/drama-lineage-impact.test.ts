import { describe, expect, it } from "vitest";
import { buildRenderInputHash, computeLineageImpact } from "../src/domain/render-input-hash.ts";

describe("drama render lineage impact", () => {
	it("hashes all authoritative revisions deterministically", () => {
		const input = {
			canonRevision: 2,
			characterLookRevision: 3,
			promptRevision: 4,
			canvasVersion: 9,
			lineageInputs: ["asset-a", "pack-b"],
		};
		expect(buildRenderInputHash(input)).toBe(
			buildRenderInputHash({ ...input, lineageInputs: [...input.lineageInputs] }),
		);
		expect(buildRenderInputHash(input)).not.toBe(buildRenderInputHash({ ...input, canvasVersion: 10 }));
	});

	it("stales only dependent shots and does not schedule an automatic rerun", () => {
		const impact = computeLineageImpact(
			[
				{ lineageId: "l1", shotId: "shot-1", characterIds: ["char-a"] },
				{ lineageId: "l2", shotId: "shot-2", characterIds: ["char-b"] },
				{ lineageId: "l3", shotId: "shot-3", characterIds: ["char-a", "char-b"] },
			],
			{ changedCharacterId: "char-a" },
		);
		expect(impact).toEqual(["l1", "l3"]);
	});
});
