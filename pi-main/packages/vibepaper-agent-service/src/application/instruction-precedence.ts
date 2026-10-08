export type InstructionSource =
	| "current-confirmation"
	| "current-user-instruction"
	| "confirmed-fact"
	| "user-preference"
	| "skill"
	| "profile-default"
	| "model-default";

export type InstructionLayer = { source: InstructionSource; text: string };

const precedence: Record<InstructionSource, number> = {
	"current-confirmation": 7,
	"current-user-instruction": 6,
	"confirmed-fact": 5,
	"user-preference": 4,
	skill: 3,
	"profile-default": 2,
	"model-default": 1,
};

export function resolveInstructionPrecedence(layers: readonly InstructionLayer[]): string[] {
	return [...layers]
		.filter((layer) => layer.text.trim())
		.sort((left: InstructionLayer, right: InstructionLayer) => precedence[right.source] - precedence[left.source])
		.map((layer) => layer.text);
}
