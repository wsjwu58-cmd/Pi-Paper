import type { AgentProfile } from "../src/domain/tool-manifest.ts";

export type EvalConfirmationMode = "none" | "auto" | "manual";
export type EvalNodeType = "text" | "image" | "video" | "audio" | "compose" | "director";
export type EvalModality = EvalNodeType;

export type EvalTurn = {
	turnId: string;
	content: string;
	confirmation: EvalConfirmationMode;
	selectedNodeIds?: readonly string[];
	canvasVersion?: number;
	entrypoint?: "canvas" | "assets" | "audit";
	canvasDomain?: "general" | "short-drama" | "assets";
};

export type EvalAssertion =
	| { type: "confirmation"; required: boolean }
	| { type: "task"; terminal: boolean }
	| { type: "node"; nodeType: EvalNodeType }
	| { type: "media"; kind: EvalModality }
	| { type: "error"; code: string }
	| { type: "event"; eventType: string }
	| { type: "lineage"; operation: string };

export type BrowserCheckpoint = {
	turnId: string;
	name: string;
};

export type EvalCase = {
	caseId: string;
	profile: AgentProfile;
	turns: EvalTurn[];
	assertions: EvalAssertion[];
	browserCheckpoints: BrowserCheckpoint[];
	tags: string[];
	skillIds?: string[];
	skillBoundaryIds?: string[];
	goal?: string;
	fixtureNodes?: readonly Record<string, unknown>[];
	/** Appendix-level IDs exercised by a multi-turn case file. */
	coverageCaseIds?: string[];
};

export type EvalEventEnvelope = {
	eventId: string;
	runId: string;
	sessionId: string;
	eventSeq: number;
	type: string;
	runtime: "pi";
	runtimeVersion: string;
	data: Record<string, unknown>;
};

export type EvalFixture = {
	caseId: string;
	sessionId: string;
	canvasId: string;
	selectedNodeIds?: readonly string[];
};

export type EvalTurnResult = {
	turnId: string;
	requestId: string;
	runId: string;
	status: "waiting_confirmation" | "completed" | "failed" | "aborted";
	actionId?: string;
	confirmationToken?: string;
	errorCode?: string;
	events: EvalEventEnvelope[];
	toolNames?: string[];
	nodeIds?: string[];
	taskIds?: string[];
	media?: Record<string, unknown>;
};

export type EvalRunResult = {
	caseId: string;
	fixture: EvalFixture;
	turns: EvalTurnResult[];
	resumedEvents: EvalEventEnvelope[];
	status: "passed" | "failed" | "blocked_external";
	assertionFailures: string[];
	evidence: {
	caseId: string;
	turns: unknown[];
	resumedEvents: unknown[];
	assertionFailures: string[];
	};
};

export const FULL_CHAIN_MODALITIES = ["text", "image", "video", "audio", "compose", "director"] as const;
export const FULL_CHAIN_OPERATIONS = [
	"img2img",
	"keyframe",
	"clip_video",
	"extract_frame",
	"upscale_image",
	"upscale_video",
	"outpaint_image",
	"mux_audio",
] as const;
export const FULL_CHAIN_SKILLS = [
	"vertical-episode",
	"short-video-script",
	"shot-storyboard",
	"dialogue-polish",
	"longform-adaptation",
	"continuity-audit",
	"character-consistency",
	"story-bible",
	"six-panel-comic",
	"product-visual",
	"product-spray-ad",
	"anti-gravity-product",
	"ecommerce-operation",
	"trend-pv",
	"vital-portrait",
	"minimal-poster",
	"film-poster",
	"cinematic-still",
	"cinematic-triptych",
	"real-scene-paper",
	"interface-design",
] as const;

const generationAssertions = new Set<EvalAssertion["type"]>(["confirmation", "task", "node", "media"]);
const stableErrorCode = /^[A-Z][A-Z0-9_]{2,63}$/;

export function assertEvalCase(value: EvalCase): void {
	if (!value.caseId.trim()) throw new Error("EVAL_CASE_ID_REQUIRED");
	if (!value.profile) throw new Error("EVAL_PROFILE_REQUIRED");
	if (value.turns.length < 2) throw new Error("EVAL_CASE_REQUIRES_AT_LEAST_2_TURNS");
	if (new Set(value.turns.map((turn) => turn.turnId)).size !== value.turns.length)
		throw new Error("EVAL_TURN_IDS_MUST_BE_UNIQUE");
	if (value.turns.some((turn) => !turn.content.trim())) throw new Error("EVAL_TURN_CONTENT_REQUIRED");
	if (value.coverageCaseIds && new Set(value.coverageCaseIds).size !== value.coverageCaseIds.length)
		throw new Error("EVAL_COVERAGE_CASE_IDS_MUST_BE_UNIQUE");
	const assertionTypes = new Set(value.assertions.map((assertion) => assertion.type));
	if (value.tags.includes("generate")) {
		for (const required of generationAssertions) {
			if (!assertionTypes.has(required)) throw new Error(`EVAL_GENERATION_ASSERTION_REQUIRED:${required}`);
		}
	}
	if (value.tags.includes("failure")) {
		const errors = value.assertions.filter((assertion): assertion is Extract<EvalAssertion, { type: "error" }> => assertion.type === "error");
		if (errors.length === 0 || errors.some((assertion) => !stableErrorCode.test(assertion.code)))
			throw new Error("EVAL_FAILURE_CASE_REQUIRES_STABLE_ERROR_CODE");
	}
	for (const checkpoint of value.browserCheckpoints) {
		if (!value.turns.some((turn) => turn.turnId === checkpoint.turnId))
			throw new Error(`EVAL_CHECKPOINT_TURN_NOT_FOUND:${checkpoint.turnId}`);
	}
}

export function buildCoverage(cases: readonly EvalCase[]) {
	const modalities = new Set<EvalModality>();
	const operations = new Set<string>();
	const caseIds: string[] = [];
	const skillIds = new Set<string>();
	let totalTurns = 0;
	for (const value of cases) {
		assertEvalCase(value);
		caseIds.push(value.caseId);
		for (const skillId of value.skillIds ?? []) skillIds.add(skillId);
		totalTurns += value.turns.length;
		for (const tag of value.tags) {
			if (["text", "image", "video", "audio", "compose", "director"].includes(tag)) modalities.add(tag as EvalModality);
			if (["img2img", "keyframe", "clip_video", "extract_frame", "upscale_image", "upscale_video", "outpaint_image", "mux_audio", "compose_videos"].includes(tag)) operations.add(tag);
		}
		for (const assertion of value.assertions) {
			if (assertion.type === "node") modalities.add(assertion.nodeType);
			else if (assertion.type === "media") modalities.add(assertion.kind);
			if (assertion.type === "lineage") operations.add(assertion.operation);
		}
	}
	return { modalities, operations, skillIds, caseIds, totalTurns };
}

export function coverageGaps(coverage: ReturnType<typeof buildCoverage>) {
	return {
		modalities: FULL_CHAIN_MODALITIES.filter((value) => !coverage.modalities.has(value)),
		operations: FULL_CHAIN_OPERATIONS.filter((value) => !coverage.operations.has(value)),
		skillIds: FULL_CHAIN_SKILLS.filter((value) => !coverage.skillIds.has(value)),
		minimumTurns: coverage.totalTurns < 32,
	};
}

export function parseEvalCase(value: unknown, source = "eval-case"): EvalCase {
	if (typeof value !== "object" || value === null) throw new Error(`INVALID_EVAL_CASE:${source}`);
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.turns) || !Array.isArray(record.assertions) || !Array.isArray(record.browserCheckpoints))
		throw new Error(`INVALID_EVAL_CASE_SCHEMA:${source}`);
	const evalCase = value as EvalCase;
	assertEvalCase(evalCase);
	return evalCase;
}
