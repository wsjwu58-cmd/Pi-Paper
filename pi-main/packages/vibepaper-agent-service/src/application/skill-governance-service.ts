import { createHash } from "node:crypto";

export type SkillVersion = {
	skillId: string;
	version: number;
	sha256: string;
	content: string;
	capabilities: readonly string[];
	maxContextTokens: number;
	riskStatus: "approved";
};

export type PublishSkillInput = {
	skillId: string;
	markdown: string;
	capabilities: readonly string[];
	maxContextTokens: number;
};

export class SkillGovernanceService {
	private readonly maxContextTokens: number;
	private readonly allowedCapabilities: ReadonlySet<string>;
	private readonly versions = new Map<string, SkillVersion[]>();

	constructor(options: { maxContextTokens: number; allowedCapabilities?: readonly string[] }) {
		this.maxContextTokens = options.maxContextTokens;
		this.allowedCapabilities = new Set(options.allowedCapabilities ?? ["read_canvas", "read_assets", "read_tasks"]);
	}

	async publish(input: PublishSkillInput): Promise<SkillVersion> {
		if (input.maxContextTokens > this.maxContextTokens) throw new Error("SKILL_CONTEXT_LIMIT_EXCEEDED");
		if (input.capabilities.some((capability) => !this.allowedCapabilities.has(capability)))
			throw new Error("SKILL_CAPABILITY_DENIED");
		const content = normalizeMarkdown(input.markdown);
		if (
			/(ignore\s+(all|any|the)\s+previous|reveal\s+(secrets?|system)|disable\s+safety|system\s+message)/i.test(
				content,
			)
		)
			throw new Error("SKILL_RISK_REJECTED");
		const existing = this.versions.get(input.skillId) ?? [];
		const version: SkillVersion = {
			skillId: input.skillId,
			version: existing.length + 1,
			sha256: createHash("sha256").update(content).digest("hex"),
			content,
			capabilities: [...new Set(input.capabilities)],
			maxContextTokens: input.maxContextTokens,
			riskStatus: "approved",
		};
		existing.push(version);
		this.versions.set(input.skillId, existing);
		return version;
	}

	get(skillId: string, version: number): SkillVersion | undefined {
		return this.versions.get(skillId)?.find((candidate) => candidate.version === version);
	}
}

function normalizeMarkdown(markdown: string): string {
	return markdown.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
}
