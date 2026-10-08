import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvalRunResult } from "./eval-schema.ts";
import { redactForEvidence } from "./eval-client.ts";
import { probeRemoteMedia } from "./media-probe.ts";

export function collectEvidenceEvents(result: EvalRunResult) {
	return result.turns.flatMap((turn) => turn.events).concat(result.resumedEvents);
}

export async function writeEvalEvidence(root: string, result: EvalRunResult): Promise<void> {
	const directory = join(root, result.caseId);
	await mkdir(directory, { recursive: true });
	const evidence = redactForEvidence(result);
	await writeFile(join(directory, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	await writeFile(
		join(directory, "events.ndjson"),
		collectEvidenceEvents(result).map((event) => JSON.stringify(redactForEvidence(event))).join("\n") + "\n",
		"utf8",
	);
	const mediaUrls = collectEvidenceEvents(result)
		.map((event) => event.data.output)
		.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value))
		.map((output) => output.url)
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	const uniqueMediaUrls = [...new Set(mediaUrls)];
	const probes = await Promise.all(uniqueMediaUrls.map((url) => probeRemoteMedia(url)));
	const status = probes.length === 0 ? "not_run" : probes.every((probe) => !probe.error && probe.sizeBytes > 0) ? "passed" : "failed";
	await writeFile(
		join(directory, "media-probe.json"),
		`${JSON.stringify(
			probes.length === 0
				? { status, reason: "No media output was available to probe" }
				: { status, probes: probes.map((probe) => redactForEvidence(probe)) },
			null,
			2,
		)}\n`,
		"utf8",
	);
}
