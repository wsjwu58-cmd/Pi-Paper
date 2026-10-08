import { describe, expect, it, vi } from "vitest";
import { generateOfficialImage } from "../src/media/official-images.ts";
import type { OfficialGenerationInput } from "../src/media/types.ts";

const API_KEY = "fixture-key-do-not-log";

function input(overrides: Partial<OfficialGenerationInput> = {}): OfficialGenerationInput {
	return {
		providerId: "google",
		modelId: "gemini-3.1-flash-image",
		modality: "image",
		prompt: "A paper kite above the sea.",
		params: {},
		references: [],
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("verified official image model protocols", () => {
	it.each([
		["gemini-3.1-flash-image", "2K", "1:4"],
		["gemini-3.1-flash-lite-image", "1K", "21:9"],
		["gemini-3-pro-image", "4K", "21:9"],
	])("uses Google Interactions for %s", async (modelId, imageSize, aspectRatio) => {
		let requestUrl = "";
		let requestBody: Record<string, unknown> = {};
		let headers: RequestInit["headers"] | undefined;
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(url);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			headers = init?.headers;
			return jsonResponse({
				steps: [
					{
						type: "model_output",
						content: [
							{ type: "text", text: "A kite over water." },
							{ type: "image", data: "aW1hZ2U=", mime_type: "image/jpeg" },
						],
					},
				],
				usage: { input_tokens: 11, output_tokens: 22 },
			});
		});

		const result = await generateOfficialImage(
			input({
				modelId,
				params: { image_size: imageSize, aspect_ratio: aspectRatio, mime_type: "image/jpeg" },
				references: [{ type: "image", role: "object", base64: "aGVsbG8=", mimeType: "image/png" }],
			}),
			{ apiKey: API_KEY, fetch },
		);

		expect(requestUrl).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
		expect(new Headers(headers).get("x-goog-api-key")).toBe(API_KEY);
		expect(requestBody).toMatchObject({
			model: modelId,
			input: [
				{ type: "text", text: "A paper kite above the sea." },
				{ type: "image", mime_type: "image/png", data: "aGVsbG8=" },
			],
			response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspectRatio, image_size: imageSize },
		});
		expect(result).toMatchObject({
			text: "A kite over water.",
			outputs: [{ base64: "aW1hZ2U=", mimeType: "image/jpeg" }],
			usage: { input_tokens: 11, output_tokens: 22 },
		});
	});

	it("enforces Google model-specific reference and image-size limits before sending", async () => {
		const fetch = vi.fn(async () => jsonResponse({ output_image: { data: "aW1hZ2U=" } }));
		await expect(
			generateOfficialImage(input({ modelId: "gemini-3.1-flash-lite-image", params: { image_size: "2K" } }), {
				apiKey: API_KEY,
				fetch,
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_SIZE" });
		await expect(
			generateOfficialImage(
				input({
					modelId: "gemini-3-pro-image",
					references: Array.from({ length: 7 }, () => ({
						type: "image" as const,
						base64: "aGVsbG8=",
						role: "object",
					})),
				}),
				{ apiKey: API_KEY, fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_LIMIT" });
		await expect(
			generateOfficialImage(input({ modelId: "gemini-4-image" }), { apiKey: API_KEY, fetch }),
		).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("treats OpenAI 1K as a resolution hint while preserving explicit-size conflicts", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ data: [{ b64_json: "aW1hZ2U=" }] });
		});
		await generateOfficialImage(
			input({
				providerId: "openai",
				modelId: "gpt-image-2",
				params: { size: "1K", ratio: "2:3" },
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestBody).toMatchObject({ model: "gpt-image-2", size: "1024x1536" });

		await expect(
			generateOfficialImage(
				input({
					providerId: "openai",
					modelId: "gpt-image-2",
					params: { size: "1024x1024", ratio: "2:3" },
				}),
				{ apiKey: API_KEY, fetch },
			),
		).rejects.toMatchObject({ code: "IMAGE_SIZE_RATIO_MISMATCH" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("normalizes canvas aspect, resolution, style, camera, and reference aliases for Google", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ output_image: { data: "aW1hZ2U=" } });
		});
		await generateOfficialImage(
			input({
				params: {
					aspect: "2:3",
					ratio: "2:3",
					resKey: "1K",
					resolution: "1K",
					size: "1K",
					count: 1,
					style: "ink wash",
					camera: "close framing",
					referenceTexts: ["keep the kite red"],
					referenceImages: ["data:image/png;base64,aGVsbG8="],
					referenceUrls: ["data:image/png;base64,aGVsbG8="],
					imageUrl: "data:image/png;base64,aGVsbG8=",
					upstreamNodeIds: ["node-safe-id"],
				},
			}),
			{ apiKey: API_KEY, fetch },
		);
		const request = requestBody.input as Array<Record<string, unknown>>;
		expect(request).toHaveLength(2);
		expect(request[0].text).toContain("Style: ink wash");
		expect(request[0].text).toContain("Camera or framing: close framing");
		expect(request[0].text).toContain("- keep the kite red");
		expect(request[1]).toMatchObject({ type: "image", mime_type: "image/png", data: "aGVsbG8=" });
		expect(requestBody.response_format).toMatchObject({ aspect_ratio: "2:3", image_size: "1K" });
	});

	it("sends the verified Seedream 5.0 Pro model ID and rejects unsupported output counts", async () => {
		let requestUrl = "";
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(url);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ data: [{ b64_json: "aW1hZ2U=", output_format: "png" }] });
		});
		const result = await generateOfficialImage(
			input({
				providerId: "volcengine",
				modelId: "doubao-seedream-5-0-pro-260628",
				params: { size: "1.5K", operation: "generation", watermark: false },
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
		expect(requestBody).toMatchObject({
			model: "doubao-seedream-5-0-pro-260628",
			size: "1.5K",
			watermark: false,
			stream: false,
		});
		expect(result.outputs).toEqual([{ base64: "aW1hZ2U=", mimeType: "image/png" }]);

		await expect(
			generateOfficialImage(
				input({ providerId: "volcengine", modelId: "doubao-seedream-5-0-pro-260628", params: { n: 2 } }),
				{ apiKey: API_KEY, fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_COUNT" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("maps Ark resolution plus canvas ratio to validated dimensions and preserves canvas references", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ data: [{ b64_json: "aW1hZ2U=" }] });
		});
		await generateOfficialImage(
			input({
				providerId: "volcengine",
				modelId: "doubao-seedream-5-0-pro-260628",
				params: {
					size: "2K",
					resolution: "2K",
					resKey: "2K",
					aspect: "2:3",
					ratio: "2:3",
					count: 1,
					style: "editorial",
					camera: "portrait crop",
					referenceTexts: ["same red kite"],
					referenceUrls: ["data:image/png;base64,aGVsbG8="],
					upstreamNodeIds: ["node-1"],
				},
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestBody).toMatchObject({ model: "doubao-seedream-5-0-pro-260628", size: "1664x2496" });
		expect(requestBody.prompt).toContain("Style: editorial");
		expect(requestBody.prompt).toContain("Camera or framing: portrait crop");
		expect(requestBody.prompt).toContain("Reference descriptions:");
		expect(requestBody.image).toBe("data:image/png;base64,aGVsbG8=");
	});

	it("maps Seedream Lite group count to max_images and enforces combined reference/output limit", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ data: [{ url: "https://ark.example/image.png", output_format: "png" }] });
		});
		const result = await generateOfficialImage(
			input({
				providerId: "volcengine",
				modelId: "doubao-seedream-5-0-260128",
				params: { size: "3K", sequential_image_generation: "auto", n: 2 },
				references: [{ type: "image", base64: "aGVsbG8=", mimeType: "image/png" }],
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestBody).toMatchObject({
			model: "doubao-seedream-5-0-260128",
			sequential_image_generation: "auto",
			sequential_image_generation_options: { max_images: 2 },
		});
		expect(result.outputs).toEqual([{ url: "https://ark.example/image.png", mimeType: "image/png" }]);
		await expect(
			generateOfficialImage(
				input({
					providerId: "volcengine",
					modelId: "doubao-seedream-5-0-260128",
					params: { sequential_image_generation: "auto", n: 2 },
					references: Array.from({ length: 14 }, () => ({ type: "image" as const, base64: "aGVsbG8=" })),
				}),
				{ apiKey: API_KEY, fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_LIMIT" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("uses DashScope sync generation for Qwen Image Edit Plus", async () => {
		let requestUrl = "";
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(url);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				output: {
					choices: [{ message: { content: [{ type: "image", image: "data:image/png;base64,aW1hZ2U=" }] } }],
				},
			});
		});
		const result = await generateOfficialImage(
			input({
				providerId: "alibaba",
				modelId: "qwen-image-edit-plus",
				operation: "edit",
				params: { size: "1024x1024", n: 2, prompt_extend: false, seed: 7 },
				references: [{ type: "image", base64: "aGVsbG8=", mimeType: "image/png" }],
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestUrl).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
		expect(requestBody).toMatchObject({
			model: "qwen-image-edit-plus",
			input: {
				messages: [
					{
						role: "user",
						content: [{ image: "data:image/png;base64,aGVsbG8=" }, { text: "A paper kite above the sea." }],
					},
				],
			},
			parameters: { size: "1024*1024", n: 2, prompt_extend: false, seed: 7 },
		});
		expect(result.outputs).toEqual([{ base64: "aW1hZ2U=", mimeType: "image/png" }]);
	});

	it("uses Wan 2.7 Image Pro's sync multimodal protocol and validates its edit bounds", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				output: {
					choices: [{ message: { content: [{ image: "https://dashscope.example/image.png", type: "image" }] } }],
				},
			});
		});
		const result = await generateOfficialImage(
			input({
				providerId: "alibaba",
				modelId: "wan2.7-image-pro",
				operation: "edit",
				params: { size: "2K", watermark: false, n: 2, bbox_list: [[[0, 0, 10, 12]]] },
				references: [{ type: "image", base64: "aGVsbG8=", mimeType: "image/png" }],
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestBody).toMatchObject({
			model: "wan2.7-image-pro",
			input: {
				messages: [
					{ content: [{ image: "data:image/png;base64,aGVsbG8=" }, { text: "A paper kite above the sea." }] },
				],
			},
			parameters: { size: "2K", n: 2, watermark: false, bbox_list: [[[0, 0, 10, 12]]] },
		});
		expect(result.outputs).toEqual([{ url: "https://dashscope.example/image.png", mimeType: "image/png" }]);

		await expect(
			generateOfficialImage(
				input({
					providerId: "alibaba",
					modelId: "wan2.7-image-pro",
					params: { size: "4K" },
					references: [{ type: "image", base64: "aGVsbG8=" }],
				}),
				{ apiKey: API_KEY, fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_SIZE" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("maps Wan shorthand resolution plus canvas aspect to custom dimensions", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				output: {
					choices: [{ message: { content: [{ image: "https://dashscope.example/image.png", type: "image" }] } }],
				},
			});
		});
		await generateOfficialImage(
			input({
				providerId: "alibaba",
				modelId: "wan2.7-image-pro",
				params: { size: "2K", resolution: "2K", ratio: "2:3", count: 1 },
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect((requestBody.parameters as Record<string, unknown>).size).toBe("1672*2508");
	});

	it("maps Alibaba Qwen resolution aliases and references from canvas parameters", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				output: { choices: [{ message: { content: [{ image: "data:image/png;base64,aW1hZ2U=" }] } }] },
			});
		});
		await generateOfficialImage(
			input({
				providerId: "alibaba",
				modelId: "qwen-image-edit-plus",
				operation: "edit",
				params: {
					size: "1024x1024",
					resolution: "1024x1024",
					ratio: "2:3",
					count: 1,
					referenceImages: ["data:image/png;base64,aGVsbG8="],
					referenceTexts: ["preserve the blue border"],
					upstreamNodeIds: ["node-a"],
				},
			}),
			{ apiKey: API_KEY, fetch },
		);
		const payload = requestBody.parameters as Record<string, unknown>;
		expect(payload).toMatchObject({ size: "836*1254", n: 1 });
		const content = (requestBody.input as { messages: Array<{ content: Array<Record<string, string>> }> }).messages[0]
			.content;
		expect(content[0]).toMatchObject({ image: "data:image/png;base64,aGVsbG8=" });
		expect(content[1].text).toContain("preserve the blue border");
	});

	it("uses Z-Image Turbo for text-only, single-output image generation", async () => {
		let requestBody: Record<string, unknown> = {};
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				output: { choices: [{ message: { content: [{ image: "https://dashscope.example/z-image.png" }] } }] },
			});
		});
		const result = await generateOfficialImage(
			input({
				providerId: "alibaba",
				modelId: "z-image-turbo",
				params: { size: "1024x1536", prompt_extend: false, seed: 10, count: 1 },
			}),
			{ apiKey: API_KEY, fetch },
		);
		expect(requestBody).toMatchObject({
			model: "z-image-turbo",
			input: { messages: [{ content: [{ text: "A paper kite above the sea." }] }] },
			parameters: { size: "1024*1536", prompt_extend: false, seed: 10 },
		});
		expect(result.outputs).toEqual([{ url: "https://dashscope.example/z-image.png", mimeType: "image/png" }]);

		await expect(
			generateOfficialImage(
				input({
					providerId: "alibaba",
					modelId: "z-image-turbo",
					references: [{ type: "image", base64: "aGVsbG8=" }],
				}),
				{ apiKey: API_KEY, fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_LIMIT" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps official request hosts restricted", async () => {
		const fetch = vi.fn(async () => jsonResponse({ output_image: { data: "aW1hZ2U=" } }));
		await expect(
			generateOfficialImage(input({ providerId: "google" }), {
				apiKey: API_KEY,
				baseUrl: "https://attacker.example/v1beta",
				fetch: undefined,
			}),
		).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
		expect(fetch).not.toHaveBeenCalled();
	});
});
