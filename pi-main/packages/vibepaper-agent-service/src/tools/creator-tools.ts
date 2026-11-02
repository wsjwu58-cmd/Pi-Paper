import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

// Main applies the same 8 MiB limit to the complete package manifest.
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;

const Component = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 80 }),
		type: Type.Union([
			Type.Literal("template"),
			Type.Literal("preset"),
			Type.Literal("node_definition"),
			Type.Literal("agent_role"),
			Type.Literal("workflow_recipe"),
			Type.Literal("selection_command"),
			Type.Literal("storyboard"),
		]),
		name: Type.String({ minLength: 1, maxLength: 64 }),
		description: Type.String({ maxLength: 1024 }),
		data: Type.Unknown(),
	},
	{ additionalProperties: false },
);
const Draft = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 64 }),
		description: Type.String({ maxLength: 1024 }),
		components: Type.Array(Component, { minItems: 1, maxItems: 20 }),
	},
	{ additionalProperties: false },
);
const DraftInput = Type.Union([Draft, Type.String({ minLength: 2, maxLength: MAX_DRAFT_BYTES })]);
const Package = Type.Object(
	{
		packageId: Type.String({ minLength: 1, maxLength: 80 }),
		digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);
const CreatorValidate = Type.Object({ draft: DraftInput }, { additionalProperties: false });
const CreatorSave = Type.Object(
	{ draft: DraftInput, draftDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }), base: Type.Optional(Package) },
	{ additionalProperties: false },
);
const Selected = Type.Object(
	{
		packageId: Type.String({ minLength: 1, maxLength: 80 }),
		digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		componentId: Type.String({ minLength: 1, maxLength: 80 }),
	},
	{ additionalProperties: false },
);

export interface MarketplaceToolContext {
	mode: "standard" | "creator";
	canvasVersion: number;
	request(action: string, input: Record<string, unknown>, toolCallId: string): Promise<unknown>;
}

// Normalize before Pi's schema validation so rejected drafts are never included
// in its generic validation error, which otherwise echoes all received arguments.
function prepareCreatorArguments<T extends TSchema>(schema: T, args: unknown): Static<T> {
	const invalid = () => new Error("[INVALID_INPUT] 插件草稿或参数不符合契约，请检查结构和大小。");
	if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid();
	const input = args as Record<string, unknown>;
	let draft = input.draft;
	if (typeof draft === "string") {
		if (Buffer.byteLength(draft, "utf8") > MAX_DRAFT_BYTES) throw invalid();
		try {
			draft = JSON.parse(draft);
		} catch {
			throw invalid();
		}
	}
	if (!Value.Check(Draft, draft)) throw invalid();
	try {
		if (Buffer.byteLength(JSON.stringify(draft), "utf8") > MAX_DRAFT_BYTES) throw invalid();
	} catch {
		throw invalid();
	}
	const normalized = { ...input, draft };
	if (!Value.Check(schema, normalized)) throw invalid();
	return normalized as Static<T>;
}

function marketplaceTool<T extends TSchema>(
	context: MarketplaceToolContext,
	name: string,
	description: string,
	schema: T,
	action: string,
	prepareArguments?: (args: unknown) => Static<T>,
): AgentTool<T> {
	return {
		name,
		label: name,
		description,
		parameters: schema,
		executionMode: "sequential",
		...(prepareArguments ? { prepareArguments } : {}),
		execute: async (toolCallId, params, signal) => {
			if (signal?.aborted) throw new Error("RUN_ABORTED");
			const input = prepareArguments ? prepareArguments(params) : params;
			const output = await context.request(
				action,
				{
					...input,
					...([
						"apply",
						"preset_preview",
						"preset_undo",
						"command_preview",
						"command_apply",
						"command_undo",
					].includes(action)
						? { expectedVersion: context.canvasVersion }
						: {}),
				},
				toolCallId,
			);
			if (
				output &&
				typeof output === "object" &&
				"canvasVersion" in output &&
				Number.isSafeInteger(output.canvasVersion)
			)
				context.canvasVersion = output.canvasVersion as number;
			return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
		},
	};
}

/** Tool schemas stay in the original TypeScript Agent; Main remains the authority. */
export function createMarketplaceTools(context: MarketplaceToolContext): AgentTool[] {
	const tools: AgentTool[] = [
		marketplaceTool(
			context,
			"marketplace_inspect",
			"只读查询插件目录；按类型查看宿主 schema，指定包及组件后查看具体内容。",
			Type.Object(
				{
					componentType: Type.Optional(Type.String()),
					packageId: Type.Optional(Type.String()),
					componentId: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
			"inspect",
		),
		marketplaceTool(
			context,
			"marketplace_result",
			"读取近期操作或指定操作的持久结果；未知结果不会被重新执行。",
			Type.Object(
				{ operationKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) },
				{ additionalProperties: false },
			),
			"result",
		),
		marketplaceTool(
			context,
			"marketplace_models",
			"按模态、参考输入、分辨率和画幅查找模型及不可用原因；不会自动选择模型。",
			Type.Object(
				{
					modality: Type.Union([
						Type.Literal("text"),
						Type.Literal("image"),
						Type.Literal("video"),
						Type.Literal("audio"),
					]),
					referenceInputs: Type.Optional(
						Type.Array(
							Type.Union([
								Type.Literal("text"),
								Type.Literal("image"),
								Type.Literal("video"),
								Type.Literal("audio"),
							]),
							{ maxItems: 4 },
						),
					),
					resolution: Type.Optional(Type.String({ maxLength: 80 })),
					aspect: Type.Optional(Type.String({ maxLength: 80 })),
				},
				{ additionalProperties: false },
			),
			"model_inspect",
		),
		marketplaceTool(
			context,
			"marketplace_commands",
			"查询选区可用的宿主命令及原因。",
			Type.Object(
				{ selectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 500 }) },
				{ additionalProperties: false },
			),
			"command_inspect",
		),
		marketplaceTool(
			context,
			"marketplace_preview",
			"按已启用组件预览分镜表或排列差异；不会修改画布。",
			Type.Object(
				{
					...Selected.properties,
					selectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 500 }),
				},
				{ additionalProperties: false },
			),
			"command_preview",
		),
		marketplaceTool(
			context,
			"marketplace_command_apply",
			"仅在用户要求应用时提交已预览的选区排列；预览摘要和画布版本必须仍匹配。",
			Type.Object(
				{
					...Selected.properties,
					selectionIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 2, maxItems: 500 }),
					previewDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
				},
				{ additionalProperties: false },
			),
			"command_apply",
		),
		marketplaceTool(
			context,
			"marketplace_command_undo",
			"使用先前排列结果的操作键撤销，节点被用户修改时会拒绝。",
			Type.Object(
				{ originalOperationKey: Type.String({ minLength: 1, maxLength: 128 }) },
				{ additionalProperties: false },
			),
			"command_undo",
		),
		marketplaceTool(
			context,
			"marketplace_preview_preset",
			"预览一个已启用预设对目标节点的字段差异；模型参数必须已选用兼容模型。",
			Type.Object(
				{ ...Selected.properties, targetNodeId: Type.String({ minLength: 1, maxLength: 256 }) },
				{ additionalProperties: false },
			),
			"preset_preview",
		),
		marketplaceTool(
			context,
			"marketplace_apply",
			"应用已启用的模板、单节点定义或已预览预设；使用已安装版本摘要，不提交生成任务。",
			Type.Object(
				{
					...Selected.properties,
					values: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
					targetNodeId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
					previewDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
				},
				{ additionalProperties: false },
			),
			"apply",
		),
		marketplaceTool(
			context,
			"marketplace_undo_preset",
			"撤销先前预设变更；字段被后续编辑时拒绝覆盖。",
			Type.Object(
				{
					originalOperationKey: Type.String({ minLength: 1, maxLength: 128 }),
					targetNodeId: Type.String({ minLength: 1, maxLength: 256 }),
				},
				{ additionalProperties: false },
			),
			"preset_undo",
		),
	];
	if (context.mode === "creator")
		tools.push(
			marketplaceTool(
				context,
				"creator_validate",
				"离线检查草稿；draft 包含 name、description 和 components，每个组件包含 id、type、name、description 和 data。优先传对象，也可传 JSON 对象字符串。保存须使用此草稿的摘要；模板每个组件最多 20 个节点。",
				CreatorValidate,
				"validate",
				(args) => prepareCreatorArguments(CreatorValidate, args),
			),
			marketplaceTool(
				context,
				"creator_save",
				"保存到本项目，draft 与试算时相同，可传对象或 JSON 对象字符串；draftDigest 是该次试算返回的摘要。建立新作品或根据本项目作品的精确摘要保存新版本。保存不会安装、启用或应用。",
				CreatorSave,
				"save",
				(args) => prepareCreatorArguments(CreatorSave, args),
			),
			marketplaceTool(
				context,
				"creator_install",
				"安装明确选择的本项目组件；新安装组件默认停用。",
				Type.Object(
					{
						...Package.properties,
						componentIds: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }),
					},
					{ additionalProperties: false },
				),
				"install",
			),
			marketplaceTool(
				context,
				"creator_enable",
				"启用或停用已安装的本项目组件，不应用组件。",
				Type.Object({ ...Selected.properties, enabled: Type.Boolean() }, { additionalProperties: false }),
				"enable",
			),
		);
	return tools;
}
