import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveEvalFiles, resolveEvidenceRoot } from "./case-loader.ts";
import { HttpEvalClient, runEvalCase } from "./eval-client.ts";
import { writeEvalEvidence } from "./evidence-writer.ts";
import { buildCoverage, coverageGaps, parseEvalCase, type EvalCase, type EvalRunResult } from "./eval-schema.ts";

const caseArguments = process.argv.slice(2).filter((argument) => argument !== "--confirm");
const shouldConfirm = process.argv.includes("--confirm");
const baseUrl = process.env.VIBEPAPER_EVAL_BASE_URL ?? "http://127.0.0.1:8091";
const evidenceRoot = process.env.VIBEPAPER_EVAL_OUTPUT
	? resolve(process.env.VIBEPAPER_EVAL_OUTPUT)
	: resolveEvidenceRoot(process.cwd(), dateStamp());

const cases = await loadCases(caseArguments);
const coverage = buildCoverage(cases);
console.log(
	JSON.stringify({
		type: "coverage",
		...coverage,
		modalities: [...coverage.modalities],
		operations: [...coverage.operations],
		skillIds: [...coverage.skillIds],
	}),
);
console.log(JSON.stringify({ type: "coverage_gaps", ...coverageGaps(coverage) }));

const client = new HttpEvalClient({ baseUrl, userId: process.env.VIBEPAPER_EVAL_USER_ID });
const results: EvalRunResult[] = [];
for (const value of cases) {
	try {
		const result = await runEvalCase(client, value, { confirm: shouldConfirm });
		results.push(result);
		await writeEvalEvidence(evidenceRoot, result);
		console.log(JSON.stringify({ caseId: result.caseId, status: result.status, turns: result.turns.length }));
	} catch (error) {
		const result: EvalRunResult = {
			caseId: value.caseId,
			fixture: { caseId: value.caseId, sessionId: "", canvasId: "" },
			turns: [],
			resumedEvents: [],
			status: "blocked_external",
			assertionFailures: ["external:fixture_or_turn_unavailable"],
			evidence: { caseId: value.caseId, turns: [], resumedEvents: [], assertionFailures: ["external:fixture_or_turn_unavailable"] },
		};
		results.push(result);
		await writeEvalEvidence(evidenceRoot, result);
		console.error(JSON.stringify({ caseId: value.caseId, status: result.status, error: safeError(error) }));
	}
}

console.log(JSON.stringify({ type: "summary", evidenceRoot, cases: results.map(({ caseId, status }) => ({ caseId, status })) }));
if (results.some((result) => result.status !== "passed")) process.exitCode = 2;

async function loadCases(arguments_: readonly string[]): Promise<EvalCase[]> {
	const files = arguments_.length > 0 ? await resolveEvalFiles(arguments_, process.cwd()) : await defaultCaseFiles();
	const loaded: EvalCase[] = [];
	for (const file of files) {
		const value = JSON.parse(await readFile(file, "utf8")) as unknown;
		loaded.push(parseEvalCase(value, file));
	}
	return loaded;
}

async function defaultCaseFiles(): Promise<string[]> {
	return await resolveEvalFiles([join("evals", "cases", "*.json")], process.cwd());
}

function dateStamp(): string {
	return new Date().toISOString().slice(0, 10);
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 240) : "UNKNOWN_ERROR";
}
