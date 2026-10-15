/** Exact raster dimensions within Zhipu's documented custom-size constraints. */
export const ZHIPU_IMAGE_DIMENSIONS = {
	glm: {
		"1:1": "1280x1280",
		"3:2": "1536x1024",
		"2:3": "1024x1536",
		"4:3": "1536x1152",
		"3:4": "1152x1536",
		"16:9": "2048x1152",
		"9:16": "1152x2048",
	},
	cogview: {
		"1:1": "1024x1024",
		"3:2": "1152x768",
		"2:3": "768x1152",
		"4:3": "1024x768",
		"3:4": "768x1024",
		"16:9": "1280x720",
		"9:16": "720x1280",
	},
};

/** Only combinations explicitly supported by the CogVideoX-3 size enum. */
export const ZHIPU_VIDEO_DIMENSIONS: Record<string, Record<string, string>> = {
	"16:9": { "720p": "1280x720", "1080p": "1920x1080", "4K": "3840x2160" },
	"9:16": { "720p": "720x1280", "1080p": "1080x1920" },
	"1:1": { "1024x1024": "1024x1024" },
};

const imageModel = (apiModelId: string) => {
	const glm = apiModelId === "glm-image";
	const dimensions = glm ? ZHIPU_IMAGE_DIMENSIONS.glm : ZHIPU_IMAGE_DIMENSIONS.cogview;
	return {
		apiModelId,
		operation: "generation",
		inputModes: ["text"],
		defaults: { ratio: "1:1", size: dimensions["1:1"], quality: glm ? "hd" : "standard", watermark_enabled: true },
		constraints: {
			maximumReferences: 0,
			maximumOutputs: 1,
			acceptedAspectRatios: Object.keys(dimensions),
			acceptedSizes: Object.values(dimensions),
			sizesByAspectRatio: Object.fromEntries(Object.entries(dimensions).map(([ratio, size]) => [ratio, [size]])),
		},
	};
};

export const ZHIPU_MEDIA_MODELS: Record<string, Record<string, unknown>> = {
	"GLM-Image": imageModel("glm-image"),
	"CogView 4": imageModel("cogview-4"),
	"CogView 4 250304": imageModel("cogview-4-250304"),
	"CogView 3 Flash": imageModel("cogview-3-flash"),
	"CogVideoX-3": {
		apiModelId: "cogvideox-3",
		operation: "task",
		inputModes: ["text", "image"],
		defaults: { ratio: "16:9", resolution: "1080p", duration: 5, generate_audio: false, fps: 30, quality: "speed" },
		constraints: {
			acceptedAspectRatios: Object.keys(ZHIPU_VIDEO_DIMENSIONS),
			acceptedResolutions: ["720p", "1080p", "4K", "1024x1024"],
			resolutionsByAspectRatio: Object.fromEntries(
				Object.entries(ZHIPU_VIDEO_DIMENSIONS).map(([ratio, sizes]) => [ratio, Object.keys(sizes)]),
			),
			acceptedDurations: [5, 10],
			minimumDuration: 5,
			maximumDuration: 10,
			maximumReferences: 2,
			supportsGenerateAudio: true,
		},
	},
};
