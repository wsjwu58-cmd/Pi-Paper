import { existsSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { loadSkillFromFile, loadSkillsFromDirInternal } from "./skill-loader.ts";
import type { LoadSkillsResult, Skill } from "./skill-loader.ts";
export { loadSkillsFromDir } from "./skill-loader.ts";
export type { LoadSkillsFromDirOptions, LoadSkillsResult, SkillFrontmatter, Skill } from "./skill-loader.ts";
/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
