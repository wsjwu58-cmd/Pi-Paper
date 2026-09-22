import { describe, expect, it } from "vitest";

import { removeRepeatedOpening, updateAssistantText } from "../src/application/assistant-text.ts";

describe("assistant text streaming", () => {
	it("extends a normal streamed reply", () => {
		const first = "你好！我是小P，陪你一起创作。今天想从哪里开始？";
		const extended = "你好！我是小P，陪你一起创作。今天想从哪里开始？我们可以先做一张图。";

		expect(updateAssistantText(first, extended)).toEqual({ next: extended, delta: "我们可以先做一张图。", replace: false });
	});

	it("replaces a non-continuous reply that restarts with the same opening", () => {
		const first = "你好！我是小P，陪你一起创作。今天想从哪里开始？可以先聊聊你的灵感。";
		const restarted = "你好！我是小P，陪你一起创作。今天想从哪里开始？我们可以先做一张图。";

		expect(updateAssistantText(first, restarted)).toEqual({ next: restarted, delta: restarted, replace: true });
	});

	it("keeps the later complete copy from a persisted duplicated reply", () => {
		const opening = "你好！我是小P，陪你一起创作。今天想从哪里开始？";
		expect(removeRepeatedOpening(`${opening} 可以先聊聊灵感。\n\n${opening} 我们可以先做一张图。`)).toBe(`${opening} 我们可以先做一张图。`);
	});
});
