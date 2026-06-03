/**
 * Result message improvement for the tool input repair layer.
 *
 * When relational defaults are applied (e.g. read's offset/limit), we
 * surface a non-error note back to the model so it can self-correct.
 * This module tracks which call IDs had relational repairs and
 * produces the improved result content.
 */

import { DEGENERATE_AUTO_LINK, READ_DEFAULT_LIMIT, READ_DEFAULT_OFFSET } from "./config.js";

// ---------------------------------------------------------------------------
// State: which tool calls had relational repairs
// ---------------------------------------------------------------------------

/**
 * Maps toolCallId → list of relational repair tags.
 * Used to improve the corresponding tool_result without touching other results.
 */
export const relationalRepairCalls = new Map<string, string[]>();

/**
 * Record that a tool call received relational repairs.
 * Called from the tool_call handler after the repair pipeline runs.
 */
export function trackRelationalRepair(
	toolCallId: string,
	repairs: string[],
): void {
	relationalRepairCalls.set(toolCallId, repairs);
}

// ---------------------------------------------------------------------------
// Result improvement
// ---------------------------------------------------------------------------

/**
 * If the tool call had relational repairs, produce improved result content
 * that surfaces what defaults were applied as informational notes (not errors).
 *
 * Returns `undefined` if no improvement is needed, so the caller can pass
 * the return value directly as the event handler result.
 */
export function improveResult(
	event: {
		toolCallId: string;
		toolName: string;
		input: unknown;
		content: Array<{ type: string; text?: string }>;
	},
): { content: Array<{ type: "text"; text: string }> } | undefined {
	const relationalRepairs = relationalRepairCalls.get(event.toolCallId);
	if (!relationalRepairs || relationalRepairs.length === 0) return undefined;

	relationalRepairCalls.delete(event.toolCallId);

	if (event.toolName === "read") {
		const input = event.input as Record<string, unknown>;
		void input; // used below in note text
		const notes: string[] = [];

		for (const repair of relationalRepairs) {
			if (repair === "relational_default:limit_from_offset") {
				notes.push(
					`Note: limit was not provided; defaulted to ${READ_DEFAULT_LIMIT} lines. To read more or fewer lines, retry with both offset and limit.`,
				);
			}
			if (repair === "relational_default:offset_from_limit") {
				notes.push(
					`Note: offset was not provided; defaulted to line ${READ_DEFAULT_OFFSET}. To start from a different line, retry with both offset and limit.`,
				);
			}
		}

		if (notes.length > 0) {
		return {
			content: [
				...event.content as Array<{ type: "text"; text: string }>,
				{ type: "text" as const, text: notes.join("\n") },
			],
		};
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Auto-link stripping (reused for nested path fields)
// ---------------------------------------------------------------------------

/**
 * Strip markdown auto-links from a single string value.
 * Only unwraps the degenerate case where link text equals the URL minus protocol.
 * Real markdown links like `[click](https://x.com)` pass through untouched.
 */
export function stripAutoLinksFromValue(value: string): string | null {
	const newValue = value.replace(DEGENERATE_AUTO_LINK, (match, linkText, url) => {
		const normalizedText = linkText.replace(/\s+/g, "");
		const normalizedUrl = url.replace(/\s+/g, "").replace(/^https?:\/\//, "");

		// Only unwrap when link text IS the filename (degenerate case)
		if (normalizedText === normalizedUrl || normalizedText.endsWith(normalizedUrl)) {
			return linkText;
		}
		// Real markdown link — pass through untouched
		return match;
	});

	return newValue !== value ? newValue : null;
}