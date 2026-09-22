export type AssistantTextUpdate = {
	next: string;
	delta: string;
	replace: boolean;
};

/**
 * Pi normally streams an ever-longer reply snapshot. Some providers can restart
 * the same reply mid-stream, however. Treat a substantial repeated opening as
 * a replacement snapshot instead of appending a second visible paragraph.
 */
export function updateAssistantText(previous: string, incoming: string): AssistantTextUpdate {
	if (!previous) return { next: incoming, delta: incoming, replace: false };
	if (!incoming || previous === incoming || previous.startsWith(incoming)) {
		return { next: previous, delta: "", replace: false };
	}
	if (incoming.startsWith(previous)) {
		return { next: incoming, delta: incoming.slice(previous.length), replace: false };
	}
	if (sharedPrefixLength(previous, incoming) >= 24) {
		return { next: incoming, delta: incoming, replace: true };
	}
	return { next: `${previous}\n\n${incoming}`, delta: incoming, replace: false };
}

/** Keep the most complete copy when an already persisted reply repeats its opening. */
export function removeRepeatedOpening(content: string): string {
	let normalized = content.trim();
	while (normalized.length >= 48) {
		const anchor = normalized.slice(0, Math.min(24, normalized.length));
		const repeatAt = normalized.indexOf(anchor, anchor.length);
		if (repeatAt < 24) break;
		normalized = normalized.slice(repeatAt).trim();
	}
	return normalized;
}

function sharedPrefixLength(left: string, right: string): number {
	const max = Math.min(left.length, right.length);
	let index = 0;
	while (index < max && left[index] === right[index]) index += 1;
	return index;
}
