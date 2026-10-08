import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import type { DramaStateStore } from "../domain/drama-state.ts";

const PrepareShotSchema = Type.Object({ shotId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export function createDramaTools(store: DramaStateStore): AgentTool[] {
	const prepareKeyframe: AgentTool<typeof PrepareShotSchema, { shotId: string; referencePackIds: readonly string[] }> =
		{
			name: "prepare_keyframe_node",
			label: "准备关键帧节点",
			description: "为已存在的镜头准备关键帧节点，并强制挂载已批准的角色参考包。",
			parameters: PrepareShotSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				const draft = await store.prepareKeyframeNode(params.shotId);
				return {
					content: [{ type: "text", text: "关键帧节点已准备，并已挂载角色参考。" }],
					details: { shotId: draft.shotId, referencePackIds: draft.referencePackIds },
				};
			},
		};

	const prepareVideo: AgentTool<typeof PrepareShotSchema, { shotId: string; keyframeRenderId: string }> = {
		name: "prepare_video_node",
		label: "准备视频节点",
		description: "仅为拥有已接受关键帧和角色参考的镜头准备视频节点。",
		parameters: PrepareShotSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const draft = await store.prepareVideoNode(params.shotId);
			return {
				content: [{ type: "text", text: "视频节点已准备，将复用关键帧和角色参考。" }],
				details: { shotId: draft.shotId, keyframeRenderId: draft.keyframeRenderId },
			};
		},
	};

	return [prepareKeyframe, prepareVideo];
}
