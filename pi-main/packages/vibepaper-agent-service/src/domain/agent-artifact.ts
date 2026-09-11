/** Fixed roles prevent recursive, unbounded sub-agent delegation. */
export const AGENT_ARTIFACT_ROLES = ["lead", "script", "storyboard", "visual", "audit"] as const;
export type AgentArtifactRole = (typeof AGENT_ARTIFACT_ROLES)[number];

/**
 * The only cross-role data format.  It is deliberately content-only: an
 * artifact cannot contain a tool invocation, confirmation token, or canvas
 * mutation.  Lead may turn validated artifacts into a plan later, through the
 * normal compiler and Tool Gateway path.
 */
export interface AgentArtifact {
	id: string;
	planId: string;
	producerRole: AgentArtifactRole;
	schemaVersion: number;
	content: Record<string, unknown>;
	evidenceRefs: readonly string[];
	createdAt: string;
}
