import type { Api, Model } from "../types.ts";

export type OfficialModality = "text" | "image" | "video" | "audio";
export type OfficialTaskStatus = "submitted" | "running" | "succeeded" | "failed" | "cancelled";

/** A project-validated reference supplied to an official provider adapter. */
export interface OfficialMediaReference {
	type: "image" | "video" | "audio";
	url?: string;
	base64?: string;
	mimeType?: string;
	role?: string;
}

export interface OfficialGenerationInput {
	providerId: string;
	modelId: string;
	/** Model-specific endpoint root, when the provider uses different API paths by modality. */
	apiBaseUrl?: string;
	modality: OfficialModality;
	prompt: string;
	operation?: "chat" | "generation" | "edit" | "speech" | "voice-change" | "music" | "task";
	pluginKey?: string;
	params?: Record<string, unknown>;
	references?: OfficialMediaReference[];
	remoteTaskId?: string;
}

export interface OfficialGenerationOptions {
	apiKey?: string;
	/** Provider-specific credentials, such as a voice ID or regional/workspace ID. */
	credentials?: Record<string, string>;
	/** Provider API root, for example `https://api.openai.com/v1`. */
	baseUrl?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Called after local validation and immediately before a billable submission request. */
	onSubmitting?: () => void | Promise<void>;
	onSubmitted?: (remoteTaskId: string) => void | Promise<void>;
	/** Test seam; production callers should omit this. */
	fetch?: typeof globalThis.fetch;
}

export interface OfficialMediaOutput {
	url?: string;
	base64?: string;
	mimeType: string;
}

export interface OfficialGenerationResult {
	text?: string;
	outputs?: OfficialMediaOutput[];
	usage?: Record<string, number>;
	remoteTaskId?: string;
	status?: OfficialTaskStatus;
	errorCode?: string;
	errorMessage?: string;
}

export interface ResolvedOfficialTextModel {
	model: Model<Api>;
	apiKey: string;
}
