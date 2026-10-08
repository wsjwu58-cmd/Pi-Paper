import { describe, expect, it } from "vitest";
import {
	type CharacterProfile,
	type CharacterReferencePack,
	createDramaAgent,
	DramaDomainError,
	type DramaSeries,
	InMemoryDramaStateStore,
	type ShotSpec,
	STANDARD_VERTICAL_SHORT_DRAMA_FORMAT,
	VERTICAL_SHORT_DRAMA_SYSTEM_PROMPT,
} from "../src/index.ts";

const series: DramaSeries = {
	id: "series-1",
	canvasId: "canvas-1",
	activeCanonRevision: 1,
	format: STANDARD_VERTICAL_SHORT_DRAMA_FORMAT,
};

const character: CharacterProfile = {
	id: "hero-1",
	seriesId: series.id,
	name: "橘猫侠",
	identityAnchors: ["琥珀色右眼", "左耳缺口", "橘白相间短毛", "红色铜铃项圈"],
	activeLookRevision: 1,
	voiceId: "voice-hero-1",
};

const referencePack: CharacterReferencePack = {
	id: "ref-hero-1",
	characterId: character.id,
	lookRevision: 1,
	status: "approved",
	frontAssetId: "asset-front",
	sideAssetId: "asset-side",
	backAssetId: "asset-back",
	expressionAssetIds: ["asset-expression"],
};

const shot: ShotSpec = {
	id: "shot-1",
	seriesId: series.id,
	episodeNo: 1,
	shotNo: 1,
	durationSeconds: 3,
	characterBindings: [{ characterId: character.id, lookRevision: 1 }],
	promptRevision: 1,
};

function createReadyStore(): InMemoryDramaStateStore {
	const store = new InMemoryDramaStateStore();
	store.createSeries(series);
	store.createCharacter(character);
	store.addReferencePack(referencePack);
	store.createShot(shot);
	return store;
}

function expectDomainError(action: () => void, code: string): void {
	try {
		action();
		throw new Error(`Expected domain error ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(DramaDomainError);
		expect((error as DramaDomainError).code).toBe(code);
	}
}

describe("vertical short-drama state", () => {
	it("requires three to five immutable identity anchors", () => {
		const store = new InMemoryDramaStateStore();
		store.createSeries(series);

		expectDomainError(
			() =>
				store.createCharacter({
					...character,
					id: "invalid-hero",
					identityAnchors: ["琥珀色右眼", "左耳缺口"],
				}),
			"INVALID_IDENTITY_ANCHORS",
		);
	});

	it("auto-attaches the unique approved reference pack to a character keyframe", () => {
		const store = createReadyStore();
		const draft = store.prepareKeyframeNode(shot.id);

		expect(draft.referencePackIds).toEqual([referencePack.id]);
		expect(draft.referenceAssetIds).toEqual([
			referencePack.frontAssetId,
			referencePack.sideAssetId,
			referencePack.backAssetId,
			...referencePack.expressionAssetIds,
		]);
	});

	it("rejects a character keyframe when no approved reference pack exists", () => {
		const store = new InMemoryDramaStateStore();
		store.createSeries(series);
		store.createCharacter(character);
		store.createShot(shot);

		expectDomainError(() => store.prepareKeyframeNode(shot.id), "MISSING_CHARACTER_REFERENCE");
	});

	it("rejects a character keyframe when the approved reference is ambiguous", () => {
		const store = createReadyStore();
		store.addReferencePack({ ...referencePack, id: "ref-hero-duplicate" });

		expectDomainError(() => store.prepareKeyframeNode(shot.id), "CHARACTER_REFERENCE_AMBIGUOUS");
	});

	it("rejects a video node until the matching keyframe is accepted", () => {
		const store = createReadyStore();

		expectDomainError(() => store.prepareVideoNode(shot.id), "KEYFRAME_NOT_ACCEPTED");

		store.recordKeyframe({
			id: "keyframe-1",
			shotId: shot.id,
			status: "accepted",
			referencePackIds: [referencePack.id],
		});

		expect(store.prepareVideoNode(shot.id)).toMatchObject({
			shotId: shot.id,
			keyframeRenderId: "keyframe-1",
			referencePackIds: [referencePack.id],
		});
	});

	it("marks only the changed character render lineage as stale", () => {
		const store = createReadyStore();
		store.recordKeyframe({
			id: "keyframe-1",
			shotId: shot.id,
			status: "accepted",
			referencePackIds: [referencePack.id],
		});
		store.recordLineage({
			id: "lineage-1",
			shotId: shot.id,
			keyframeRenderId: "keyframe-1",
			status: "submitted",
		});

		expect(store.markLineagesStaleForCharacter(character.id)).toEqual(["lineage-1"]);
		expect(store.markLineagesStaleForCharacter(character.id)).toEqual([]);
	});

	it("constructs a Pi agent with only vertical-drama tools and sequential execution", () => {
		const agent = createDramaAgent(createReadyStore(), {
			streamFn: () => {
				throw new Error("No model stream should run in this construction test");
			},
		});

		expect(agent.state.systemPrompt).toBe(VERTICAL_SHORT_DRAMA_SYSTEM_PROMPT);
		expect(agent.toolExecution).toBe("sequential");
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(["prepare_keyframe_node", "prepare_video_node"]);
	});

	it("does not expose the legacy draft-only drama tools to the runtime profile", () => {
		const agent = createDramaAgent(createReadyStore(), {
			profile: "vertical-short-drama",
			streamFn: () => {
				throw new Error("No model stream should run in this construction test");
			},
		});

		expect(agent.state.tools.map((tool) => tool.name)).not.toEqual(
			expect.arrayContaining(["prepare_keyframe_node", "prepare_video_node"]),
		);
	});
});
