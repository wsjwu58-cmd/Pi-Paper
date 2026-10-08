export type ContextBudget = { maxCharacters: number };

export function truncateToBudget(value: string, maxCharacters: number): string {
	return value.length <= maxCharacters ? value : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
}
