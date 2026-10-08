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
	previous = dedupeRepeatedSegments(previous);
	incoming = dedupeRepeatedSegments(incoming);
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

/**
 * A final reply can contain a repeated status sentence without repeating its
 * first line (for example, when a tool result is woven back into a streamed
 * reply). Keep the first complete sentence/emoji segment and drop later copies.
 */
export function dedupeRepeatedSegments(content: string): string {
	const seen = new Set<string>();
	return content
		.split(/(?<=[。！？\n])|(?=\p{Extended_Pictographic})/u)
		.filter((segment) => {
			const key = segment.replace(/[\s\p{P}\p{Extended_Pictographic}]/gu, "");
			if (key.length < 10 || !seen.has(key)) {
				if (key.length >= 10) seen.add(key);
				return true;
			}
			return false;
		})
		.join("")
		.trim();
}

function sharedPrefixLength(left: string, right: string): number {
	const max = Math.min(left.length, right.length);
	let index = 0;
	while (index < max && left[index] === right[index]) index += 1;
	return index;
}
