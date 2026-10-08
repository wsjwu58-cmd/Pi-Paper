import { describe, expect, it } from "vitest";

import { compileIntent, type GenerationIntent, GenerationIntentError } from "../src/domain/generation-intent.ts";

describe("generation intent compiler", () => {
	it.each([
		[{ kind: "text", prompt: "雨夜", referenceNodeIds: [] }, "text"],
		[{ kind: "image", prompt: "咖啡馆", size: "2K", ratio: "9:16", referenceNodeIds: ["story"] }, "image"],
		[
			{
				kind: "video",
				prompt: "推门",
				seconds: 4,
				size: "720P",
				aspectRatio: "9:16",
				mode: "text",
				referenceNodeIds: [],
				withAudio: false,
			},
			"video",
		],
		[{ kind: "audio", text: "你好", voice: "female", language: "zh-CN", speed: 1, tone: "calm" }, "audio"],
		[{ kind: "compose", videoNodeIds: ["v1", "v2"] }, "compose"],
		[{ kind: "derive", operation: "extract_frame", sourceNodeIds: ["v1"], params: { timestamp: 0 } }, "image"],
		[{ kind: "director", scene: { models: [], camera: { yaw: 0, pitch: 0, distance: 4 } } }, "director"],
	] as const)("compiles %s", (intent, nodeType) => {
		const plan = compileIntent(intent as GenerationIntent);
		expect(plan.node.type).toBe(nodeType);
		expect(plan.requiresApproval).toBe(nodeType !== "text");
	});

	it.each([3, 13])("rejects video duration %s", (seconds) => {
		expect(() =>
			compileIntent({
				kind: "video",
				prompt: "x",
				seconds: seconds as 4,
				size: "720P",
				aspectRatio: "9:16",
				mode: "text",
				referenceNodeIds: [],
				withAudio: false,
			}),
		).toThrowError(GenerationIntentError);
	});

	it("rejects six video references", () => {
		expect(() =>
			compileIntent({
				kind: "video",
				prompt: "x",
				seconds: 4,
				size: "720P",
				aspectRatio: "9:16",
				mode: "reference",
				referenceNodeIds: ["1", "2", "3", "4", "5", "6"],
				withAudio: false,
			}),
		).toThrowError(/最多 5/);
	});

	it("requires a frame for keyframe mode", () => {
		expect(() =>
			compileIntent({
				kind: "video",
				prompt: "x",
				seconds: 4,
				size: "720P",
				aspectRatio: "9:16",
				mode: "keyframe",
				referenceNodeIds: [],
				withAudio: false,
			}),
		).toThrowError(/关键帧/);
	});

	it("requires two videos for compose", () => {
		expect(() => compileIntent({ kind: "compose", videoNodeIds: ["only"] })).toThrowError(/至少 2/);
	});

	it("requires text or a text node for audio", () => {
		expect(() =>
			compileIntent({ kind: "audio", voice: "female", language: "zh-CN", speed: 1, tone: "calm" }),
		).toThrowError(/正文/);
	});

	it("normalizes director camera boundaries", () => {
		const plan = compileIntent({
			kind: "director",
			scene: { models: [], camera: { yaw: 999, pitch: -99, distance: 0 } },
		});
		expect(plan.node.params.scene).toMatchObject({ camera: { yaw: 180, pitch: -89, distance: 0.5 } });
	});
});
