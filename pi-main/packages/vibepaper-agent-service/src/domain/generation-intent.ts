export type GenerationIntent =
	| { kind: "text"; prompt: string; referenceNodeIds?: string[] }
	| { kind: "image"; prompt: string; size?: string; ratio?: string; referenceNodeIds?: string[] }
	| {
			kind: "video";
			prompt: string;
			seconds: 4 | 8 | 12;
			size: string;
			aspectRatio: string;
			mode: "text" | "reference" | "keyframe";
			referenceNodeIds: string[];
			keyframeNodeId?: string;
			withAudio: boolean;
	  }
	| { kind: "audio"; text?: string; textNodeId?: string; voice: string; language: string; speed: number; tone: string }
	| { kind: "compose"; videoNodeIds: string[] }
	| { kind: "derive"; operation: string; sourceNodeIds: string[]; params: Record<string, unknown> }
	| { kind: "director"; scene: DirectorScene };

export type DirectorScene = {
	models: unknown[];
	camera: { yaw: number; pitch: number; distance: number };
	[key: string]: unknown;
};

export class GenerationIntentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GenerationIntentError";
	}
}

export type CompiledGenerationIntent = {
	node: { type: "text" | "image" | "video" | "audio" | "compose" | "director"; params: Record<string, unknown> };
	requiresApproval: boolean;
};

/** Converts a user-level generation request into a validated canvas-node plan. */
export function compileIntent(intent: GenerationIntent): CompiledGenerationIntent {
	switch (intent.kind) {
		case "text":
			return plan("text", { prompt: requireText(intent.prompt, "文本提示") }, false);
		case "image":
			return plan("image", {
				...intent,
				prompt: requireText(intent.prompt, "图片提示"),
				referenceNodeIds: uniqueRefs(intent.referenceNodeIds ?? []),
			});
		case "video": {
			if (![4, 8, 12].includes(intent.seconds)) throw new GenerationIntentError("视频时长仅支持 4、8 或 12 秒");
			const references = uniqueRefs(intent.referenceNodeIds);
			if (references.length > 5) throw new GenerationIntentError("视频参考节点最多 5 个");
			if (intent.mode === "keyframe" && !intent.keyframeNodeId)
				throw new GenerationIntentError("关键帧模式需要指定关键帧");
			return plan("video", {
				...intent,
				prompt: requireText(intent.prompt, "视频提示"),
				referenceNodeIds: references,
			});
		}
		case "audio":
			if (!nonBlank(intent.text) && !nonBlank(intent.textNodeId))
				throw new GenerationIntentError("音频生成需要正文或文本节点");
			return plan("audio", { ...intent, text: intent.text?.trim() });
		case "compose":
			if (uniqueRefs(intent.videoNodeIds).length < 2) throw new GenerationIntentError("合成至少 2 个视频节点");
			return plan("compose", { ...intent, videoNodeIds: uniqueRefs(intent.videoNodeIds) });
		case "derive":
			if (uniqueRefs(intent.sourceNodeIds).length === 0) throw new GenerationIntentError("派生操作需要源节点");
			return plan("image", { ...intent, sourceNodeIds: uniqueRefs(intent.sourceNodeIds) });
		case "director":
			return plan("director", { scene: normalizeDirectorScene(intent.scene) });
	}
}

function plan(
	type: CompiledGenerationIntent["node"]["type"],
	params: Record<string, unknown>,
	requiresApproval = true,
): CompiledGenerationIntent {
	return { node: { type, params }, requiresApproval };
}

function requireText(value: string, label: string): string {
	if (!nonBlank(value)) throw new GenerationIntentError(`${label}不能为空`);
	return value.trim();
}

function nonBlank(value: string | undefined): value is string {
	return Boolean(value?.trim());
}

function uniqueRefs(values: string[]): string[] {
	return [...new Set(values.filter(nonBlank))];
}

function normalizeDirectorScene(scene: DirectorScene): DirectorScene {
	return {
		...scene,
		models: [...scene.models],
		camera: {
			yaw: clamp(scene.camera.yaw, -180, 180),
			pitch: clamp(scene.camera.pitch, -89, 89),
			distance: clamp(scene.camera.distance, 0.5, 100),
		},
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
