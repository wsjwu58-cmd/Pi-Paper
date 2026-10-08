import { describe, expect, it } from "vitest";

import { BUILTIN_SKILL_INSERT_SQL } from "../src/application/skill-bootstrap.ts";

describe("builtin skill bootstrap query", () => {
	it("casts every value used by the insert and duplicate check", () => {
		expect(BUILTIN_SKILL_INSERT_SQL).toContain("$1::bigint");
		expect(BUILTIN_SKILL_INSERT_SQL).toContain("$2::varchar");
		expect(BUILTIN_SKILL_INSERT_SQL).toContain("$3::text");
		expect(BUILTIN_SKILL_INSERT_SQL).toContain("$4::text");
		expect(BUILTIN_SKILL_INSERT_SQL).toContain("$5::varchar");
		expect(BUILTIN_SKILL_INSERT_SQL).toContain("$6::varchar");
	});
});
