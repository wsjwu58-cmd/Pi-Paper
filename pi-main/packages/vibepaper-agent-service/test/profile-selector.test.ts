import { describe, expect, it } from "vitest";

import { resolveInstructionPrecedence } from "../src/application/instruction-precedence.ts";
import { selectProfile } from "../src/application/profile-selector.ts";

describe("profile selection and instruction precedence", () => {
	it.each([
		[{ entrypoint: "audit" }, "audit-readonly"],
		[{ canvasDomain: "short-drama" }, "vertical-short-drama"],
		[{ entrypoint: "assets" }, "asset-assistant"],
		[{ canvasDomain: "general" }, "canvas-general"],
	] as const)("selects %s deterministically", (input, expected) => {
		expect(selectProfile(input)).toBe(expected);
	});

	it("orders instruction layers from the strongest constraint to the weakest default", () => {
		expect(
			resolveInstructionPrecedence([
				{ source: "model-default", text: "model" },
				{ source: "profile-default", text: "profile" },
				{ source: "current-user-instruction", text: "user" },
				{ source: "current-confirmation", text: "confirm" },
			]),
		).toEqual(["confirm", "user", "profile", "model"]);
	});
});
