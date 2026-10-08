import { AGENT_ARTIFACT_ROLES, type AgentArtifact, type AgentArtifactRole } from "../domain/agent-artifact.ts";

export interface AgentArtifactRepository {
	append(ownerId: string, artifact: AgentArtifact): Promise<AgentArtifact>;
	list(planId: string, ownerId: string): Promise<readonly AgentArtifact[]>;
}

export class AgentArtifactError extends Error {
	readonly code: "INVALID_ARTIFACT" | "ROLE_NOT_ALLOWED" | "DEPENDENCY_MISSING";

	constructor(code: AgentArtifactError["code"]) {
		super(code);
		this.name = "AgentArtifactError";
		this.code = code;
	}
}

/**
 * Coordinates typed role outputs without granting a sub-agent any tool
 * authority.  The returned artifact is data only; the caller must still go
 * through Lead, plan compilation, confirmation and the Tool Gateway to act.
 */
export class AgentArtifactService {
	private readonly repository: AgentArtifactRepository;

	constructor(repository: AgentArtifactRepository) {
		this.repository = repository;
	}

	async publish(input: {
		ownerId: string;
		actorRole: AgentArtifactRole;
		artifact: AgentArtifact;
	}): Promise<AgentArtifact> {
		if (input.actorRole !== input.artifact.producerRole) throw new AgentArtifactError("ROLE_NOT_ALLOWED");
		validateArtifact(input.artifact);
		return await this.repository.append(input.ownerId, input.artifact);
	}

	async assembleLeadSummary(input: {
		ownerId: string;
		planId: string;
		content: Record<string, unknown>;
		evidenceRefs: readonly string[];
		createdAt: string;
		id: string;
		requiredRoles?: readonly Exclude<AgentArtifactRole, "lead">[];
	}): Promise<AgentArtifact> {
		const artifacts = await this.repository.list(input.planId, input.ownerId);
		const requiredRoles = input.requiredRoles ?? ["script", "storyboard", "audit"];
		if (requiredRoles.some((role) => !artifacts.some((artifact) => artifact.producerRole === role)))
			throw new AgentArtifactError("DEPENDENCY_MISSING");
		return await this.publish({
			ownerId: input.ownerId,
			actorRole: "lead",
			artifact: {
				id: input.id,
				planId: input.planId,
				producerRole: "lead",
				schemaVersion: 1,
				content: input.content,
				evidenceRefs: input.evidenceRefs,
				createdAt: input.createdAt,
			},
		});
	}
}

export function validateArtifact(artifact: AgentArtifact): void {
	if (
		!artifact.id.trim() ||
		!artifact.planId.trim() ||
		!AGENT_ARTIFACT_ROLES.includes(artifact.producerRole) ||
		!Number.isInteger(artifact.schemaVersion) ||
		artifact.schemaVersion < 1 ||
		!isPlainRecord(artifact.content) ||
		!isIsoDate(artifact.createdAt) ||
		artifact.evidenceRefs.length > 50 ||
		artifact.evidenceRefs.some((reference) => typeof reference !== "string" || !reference.trim()) ||
		containsUnsafeExecutionField(artifact.content)
	)
		throw new AgentArtifactError("INVALID_ARTIFACT");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
	return !Number.isNaN(Date.parse(value)) && value.endsWith("Z");
}

function containsUnsafeExecutionField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsUnsafeExecutionField);
	if (!isPlainRecord(value)) return false;
	return Object.entries(value).some(
		([key, child]) =>
			/^(tool|toolCall|confirmationToken|canvasMutation)$/i.test(key) || containsUnsafeExecutionField(child),
	);
}
