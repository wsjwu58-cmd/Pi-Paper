import { expect, it } from "vitest";

import { listMcpAuxiliaryTools } from "../src/desktop/mcp-runtime.ts";

type SchemaObject = Record<string, unknown>;

function asRecord(value: unknown): SchemaObject {
	return value && typeof value === "object" && !Array.isArray(value) ? value as SchemaObject : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

it("describes the provider directory, authorized source refs, and disclosure resume contract", () => {
	const tools = listMcpAuxiliaryTools();
	const directory = tools.find((tool) => tool.name === "list_provider_configuration");
	const configure = tools.find((tool) => tool.name === "configure_provider");
	const operation = tools.find((tool) => tool.name === "get_provider_operation");
	if (!directory || !configure || !operation) throw new Error("Provider MCP tool definitions are incomplete");

	expect(directory!.description).toContain("credentialSources");
	expect(directory!.description).toContain("sourceRef");
	expect(configure!.description).toContain("list_provider_configuration");
	expect(configure!.description).toContain("awaiting_disclosure");
	expect(configure!.description).toContain("完全相同");
	expect(configure!.description).toContain("status=saved");
	expect(operation!.description).toContain("not_found");

	const input = asRecord(configure!.inputSchema);
	const properties = asRecord(input.properties);
	const publicConfig = asRecord(properties.publicConfig);
	const publicProperties = asRecord(publicConfig.properties);
	expect(publicConfig.additionalProperties).toBe(false);
	expect(Object.keys(publicProperties).sort()).toEqual([
		"baseUrl",
		"defaultModelIds",
		"enabledModelIds",
		"modelDefaults",
		"providerId",
		"timeoutSeconds",
	].sort());
	expect(asRecord(asRecord(publicProperties.enabledModelIds).items).enum).toBeUndefined();
	expect(asRecord(publicProperties.timeoutSeconds)).toMatchObject({ minimum: 10, maximum: 600 });

	const credentialInput = asRecord(properties.credentialInput);
	const authorizedEnv = asArray(credentialInput.oneOf)
		.map(asRecord)
		.find((variant) => asRecord(asRecord(variant.properties).source).const === "authorized_env");
	expect(authorizedEnv).toBeDefined();
	expect(asRecord(asRecord(asRecord(authorizedEnv?.properties).sourceRefs)).description).toContain("sourceRef");
});
