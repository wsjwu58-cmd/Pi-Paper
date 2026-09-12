import type { AgentProfile } from "../domain/tool-manifest.ts";

export type AgentIntentKind =
	| "conversation"
	| "canvas_fact"
	| "read"
	| "single_write"
	| "creative_workflow"
	| "resume";

export type IntentRouterInput = {
	content: string;
	profile: AgentProfile;
	selectedNodeCount?: number;
};

export type IntentDecision = {
	kind: AgentIntentKind;
	confidence: number;
	requiresPlan: boolean;
	requiresConfirmation: boolean;
	/** A concrete, low-risk canvas action the first model turn must perform. */
	requiredToolName?: "create_nodes";
	reasons: readonly string[];
};

const CANVAS_FACT_PATTERN = /(?:多少|几个|几条|数量|统计).{0,12}(?:节点|连线|素材|任务)|(?:节点|连线|素材|任务).{0,12}(?:多少|几个|数量)/i;
const READ_PATTERN = /(?:查看|看看|读取|列出|查询|状态|进度|有哪些|是什么)/i;
const WRITE_PATTERN = /(?:创建|新增|删除|移动|拖动|连接|连线|布局|修改|更新|改成)/i;
const CONTINUATION_PATTERN = /^(?:继续|确认|同意|执行|开始|取消|停止)(?:[。！!，,\s]|$)/i;
const WORKFLOW_PATTERN = /(?:短剧|分镜|关键帧|视频片段|故事(?:圣经|板)|工作流|编排|批量|系列|多(?:个|张|段|节点)|先.+(?:再|然后|之后)|(?:图|图片).*(?:视频)|(?:文本|文案).*(?:图|图片))/i;
const HIGH_RISK_PATTERN = /(?:生成|出图|做视频|渲染|模型|批量|覆盖)/i;
const DIRECT_SCRIPT_NODE_PATTERN = /(?:直接|立即|现在|帮我)?(?:生成|创建|新建|写入|产出).{0,16}(?:脚本|剧本|分镜|故事圣经)/i;
const POST_GENERATION_FOLLOW_UP_PATTERN = /(?:生成|出图|做视频|渲染|创建).{0,32}(?:完成|成功|之后|以后|后).{0,24}(?:告诉|建议|下一步|继续|推荐|规划|安排)/i;

/** Whether a generation request explicitly asks the Agent to act or advise afterwards. */
export function requestsPostGenerationFollowUp(content: string): boolean {
	return POST_GENERATION_FOLLOW_UP_PATTERN.test(content.trim());
}

/** A deterministic first-stage router. Ambiguous requests stay conversational. */
export function routeAgentIntent(input: IntentRouterInput): IntentDecision {
	const content = input.content.trim();
	if (CANVAS_FACT_PATTERN.test(content)) {
		return decision("canvas_fact", 0.98, false, false, ["请求画布事实统计"]);
	}
	if (CONTINUATION_PATTERN.test(content)) {
		return decision("resume", 0.9, false, false, ["请求续办、确认或取消既有动作"]);
	}
	if (DIRECT_SCRIPT_NODE_PATTERN.test(content)) {
		return decision("single_write", 0.98, false, false, ["明确要求直接创建脚本文本节点"], "create_nodes");
	}
	if (input.profile === "vertical-short-drama" || WORKFLOW_PATTERN.test(content) || (input.selectedNodeCount ?? 0) > 1) {
		return decision("creative_workflow", 0.9, true, HIGH_RISK_PATTERN.test(content), [
			"包含多步骤创作、编排或多个引用节点",
		]);
	}
	if (WRITE_PATTERN.test(content)) {
		return decision("single_write", 0.82, false, HIGH_RISK_PATTERN.test(content), ["包含单步画布写入动作"]);
	}
	if (READ_PATTERN.test(content)) {
		return decision("read", 0.78, false, false, ["包含只读查询动作"]);
	}
	return decision("conversation", 0.55, false, false, ["未命中可安全执行的确定性模式"]);
}

export function formatIntentContext(intent: IntentDecision): string {
	if (intent.requiredToolName === "create_nodes")
		return "这是明确的脚本节点创建请求：首轮必须调用创建节点工具，将完整正文写入 text/script 节点的 params.content；文字回复不能代替画布写入。";
	const planInstruction = intent.requiresPlan
		? "这是多步骤创作请求：先说明计划、依赖与需要确认的生成动作，再执行被允许的步骤。"
		: "仅在用户请求明确且工具白名单允许时执行动作；不确定时先澄清。";
	return `本轮意图：${intent.kind}。${planInstruction}`;
}

function decision(
	kind: AgentIntentKind,
	confidence: number,
	requiresPlan: boolean,
	requiresConfirmation: boolean,
	reasons: readonly string[],
	requiredToolName?: IntentDecision["requiredToolName"],
): IntentDecision {
	return { kind, confidence, requiresPlan, requiresConfirmation, reasons, requiredToolName };
}
