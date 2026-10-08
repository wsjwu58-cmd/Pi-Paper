import { stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MediaProbe = {
	path: string;
	sizeBytes: number;	
	ffprobe?: Record<string, unknown>;
	error?: string;
};

export type RemoteMediaProbe = MediaProbe & {
	statusCode?: number;
	contentType?: string;
};

export async function probeMedia(filePath: string): Promise<MediaProbe> {
	const file = await stat(filePath).catch(() => undefined);
	if (!file || !file.isFile()) return { path: filePath, sizeBytes: 0, error: "MEDIA_NOT_FOUND" };
	try {
		const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath], { windowsHide: true });
		return { path: filePath, sizeBytes: file.size, ffprobe: JSON.parse(stdout) as Record<string, unknown> };
	} catch {
		return { path: filePath, sizeBytes: file.size, error: "FFPROBE_UNAVAILABLE_OR_MEDIA_UNREADABLE" };
	}
}

export async function probeRemoteMedia(
	mediaUrl: string,
	baseUrl = process.env.VIBEPAPER_EVAL_MEDIA_BASE_URL ?? "http://127.0.0.1:8090",
	fetchFn: typeof fetch = fetch,
): Promise<RemoteMediaProbe> {
	const path = redactMediaUrl(mediaUrl);
	let url: string;
	try {
		url = new URL(mediaUrl, baseUrl).toString();
	} catch {
		return { path, sizeBytes: 0, error: "MEDIA_URL_INVALID" };
	}
	try {
		const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) return { path, sizeBytes: 0, statusCode: response.status, error: "MEDIA_FETCH_FAILED" };
		const buffer = Buffer.from(await response.arrayBuffer());
		const ffprobe = await probeBuffer(buffer);
		return {
			path,
			sizeBytes: buffer.length,
			statusCode: response.status,
			contentType: response.headers.get("content-type") ?? undefined,
			...(ffprobe.ffprobe ? { ffprobe: ffprobe.ffprobe } : {}),
			...(ffprobe.error ? { error: ffprobe.error } : {}),
		};
	} catch {
		return { path, sizeBytes: 0, error: "MEDIA_FETCH_OR_PROBE_FAILED" };
	}
}

async function probeBuffer(buffer: Buffer): Promise<Pick<MediaProbe, "ffprobe" | "error">> {
	return await new Promise((resolve) => {
		const child = spawn(
			"ffprobe",
			["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "pipe:0"],
			{ windowsHide: true },
		);
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => resolve({ error: "FFPROBE_UNAVAILABLE_OR_MEDIA_UNREADABLE" }));
		child.on("close", (code) => {
			if (code !== 0) return resolve({ error: "FFPROBE_UNAVAILABLE_OR_MEDIA_UNREADABLE" });
			try {
				resolve({ ffprobe: JSON.parse(stdout) as Record<string, unknown> });
			} catch {
				resolve({ error: "FFPROBE_INVALID_OUTPUT" });
			}
		});
		child.stdin.end(buffer);
	});
}

function redactMediaUrl(value: string): string {
	try {
		const parsed = new URL(value, "http://redacted.invalid");
		return `${parsed.origin === "http://redacted.invalid" ? "" : parsed.origin}${parsed.pathname}`.replace(
			/\/\d{6,}(?=\/|$)/g,
			"/<redacted>",
		);
	} catch {
		return "<invalid-media-url>";
	}
}
