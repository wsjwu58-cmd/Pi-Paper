import { access, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export async function resolveEvalFiles(arguments_: readonly string[], cwd = process.cwd()): Promise<string[]> {
	const files = new Set<string>();
	for (const argument of arguments_) {
		const matches = await expandArgument(argument, cwd);
		for (const file of matches) files.add(file);
	}
	if (files.size === 0) throw new Error("EVAL_CASE_FILES_NOT_FOUND");
	return [...files].sort();
}

export function resolveEvidenceRoot(cwd: string, date: string): string {
	const normalized = cwd.replaceAll("\\", "/").replace(/\/$/, "");
	const packageSuffix = "/pi-main/packages/vibepaper-agent-service";
	const repositoryRoot = normalized.toLowerCase().endsWith(packageSuffix)
		? resolve(cwd, "..", "..", "..")
		: resolve(cwd);
	return resolve(repositoryRoot, "output", "evals", date);
}

async function expandArgument(argument: string, cwd: string): Promise<string[]> {
	const normalized = argument.replaceAll("\\", "/");
	if (!normalized.includes("*")) {
		const candidate = isAbsolute(argument) ? argument : resolve(cwd, argument);
		await access(candidate);
		return [candidate];
	}
	const separator = normalized.lastIndexOf("/");
	const directoryPart = separator >= 0 ? normalized.slice(0, separator) : ".";
	const filePattern = separator >= 0 ? normalized.slice(separator + 1) : normalized;
	const expression = new RegExp(`^${filePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
	const roots = [cwd, resolve(cwd, "..", "..")];
	for (const root of roots) {
		const directory = resolve(root, directoryPart);
		try {
			const names = await readdir(directory);
			const matches = names.filter((name) => expression.test(name)).map((name) => join(directory, name));
			if (matches.length > 0) return matches;
		} catch {
			continue;
		}
	}
	throw new Error(`EVAL_CASE_FILES_NOT_FOUND:${argument}`);
}
