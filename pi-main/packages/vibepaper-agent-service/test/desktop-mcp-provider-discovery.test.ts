import { expect, it } from "vitest";

import type { ApprovalService } from "../src/application/approval-service.ts";
import { executeMcpRuntimeTool, listMcpAuxiliaryTools, listMcpRuntimeTools } from "../src/desktop/mcp-runtime.ts";
import type { RuntimeToolGateway } from "../src/tools/runtime-tools.ts";

type SchemaObject = Record<string, unknown>;

function asRecord(value: unknown): SchemaObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as SchemaObject) : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

it("describes the provider directory, authorized source refs, and direct scoped configuration", () => {
	const tools = listMcpAuxiliaryTools();
	const directory = tools.find((tool) => tool.name === "list_provider_configuration");
	const configure = tools.find((tool) => tool.name === "configure_provider");
	const operation = tools.find((tool) => tool.name === "get_provider_operation");
	if (!directory || !configure || !operation) throw new Error("Provider MCP tool definitions are incomplete");

	expect(directory!.description).toContain("credentialSources");
	expect(directory!.description).toContain("sourceRef");
	expect(configure!.description).toContain("list_provider_configuration");
	expect(configure!.description).toContain("直接保存");
	expect(configure!.description).toContain("不等待桌面批准卡");
	expect(configure!.description).not.toContain("awaiting_disclosure");
	expect(configure!.description).toContain("status=saved");
	expect(operation!.description).toContain("not_found");
	expect(operation!.description).not.toContain("awaiting_disclosure");

	const input = asRecord(configure!.inputSchema);
	const properties = asRecord(input.properties);
	const publicConfig = asRecord(properties.publicConfig);
	const publicProperties = asRecord(publicConfig.properties);
	expect(publicConfig.additionalProperties).toBe(false);
	expect(Object.keys(publicProperties).sort()).toEqual(
		["baseUrl", "defaultModelIds", "enabledModelIds", "modelDefaults", "providerId", "timeoutSeconds"].sort(),
	);
	expect(asRecord(asRecord(publicProperties.enabledModelIds).items).enum).toBeUndefined();
	expect(asRecord(publicProperties.timeoutSeconds)).toMatchObject({ minimum: 10, maximum: 600 });

	const credentialInput = asRecord(properties.credentialInput);
	const authorizedEnv = asArray(credentialInput.oneOf)
		.map(asRecord)
		.find((variant) => asRecord(asRecord(variant.properties).source).const === "authorized_env");
	expect(authorizedEnv).toBeDefined();
	expect(asRecord(asRecord(asRecord(authorizedEnv?.properties).sourceRefs)).description).toContain("sourceRef");
});

it("requires generation confirmation through client form elicitation and exposes no approval tool", async () => {
	const runtimeTools = listMcpRuntimeTools({
		clientId: "client-1",
		grantId: "grant-1",
		projectId: "project-1",
		canvasId: "canvas-1",
		canvasVersion: 3,
		gateway: {} as RuntimeToolGateway,
		approvals: {} as ApprovalService,
	});
	const prepare = runtimeTools.find((tool) => tool.name === "prepare_generation");
	if (!prepare) throw new Error("Generation MCP tool definition is missing");

	expect(prepare.description).toContain("MCP form elicitation");
	expect(prepare.description).toContain("只收集本次确认决定");
	expect(prepare.description).toContain("不收集 API Key");
	expect(prepare.description).toContain("不支持 form elicitation 时不得提交任务");
	expect(prepare.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, openWorldHint: true });
	expect(runtimeTools.map((tool) => tool.name)).not.toContain("approve_generation");
	expect(listMcpAuxiliaryTools().map((tool) => tool.name)).not.toContain("approve_generation");

	await expect(
		executeMcpRuntimeTool({
			toolName: "prepare_generation",
			arguments: {
				operationId: "operation-1",
				expectedVersion: 3,
				generations: [
					{
						nodeId: "node-1",
						modelType: "image-model",
						modelParams: { apiKey: "never-collect" },
						overwrite: false,
					},
				],
			},
			clientId: "client-1",
			grantId: "grant-1",
			projectId: "project-1",
			canvasId: "canvas-1",
			canvasVersion: 3,
			gateway: {} as RuntimeToolGateway,
			approvals: {} as ApprovalService,
		}),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
