/**
 * Core repair functions for the tool input repair layer.
 *
 * Each function takes (input, toolName) mutates `input` in-place,
 * and returns an array of repair tags describing what was changed.
 *
 * ORDER MATTERS. The pipeline is:
 *   1. stripNullFields
 *   2. parseStringifiedArrays   (before bare-string-wrap!)
 *   3. stripMarkdownAutoLinks
 *   4. unwrapSingleObjectAsArray
 *   5. wrapBareStringAsArray
 *   6. repairNestedArrayItems   (recursive)
 *   7. applyRelationalDefaults
 */

import {
	ARRAY_FIELDS,
	CONTENT_FIELDS,
	DEGENERATE_AUTO_LINK,
	OPTIONAL_NULL_FIELDS,
	PATH_FIELDS,
	READ_DEFAULT_LIMIT,
	READ_DEFAULT_OFFSET,
} from "./config.js";
import { stripAutoLinksFromValue } from "./result.js";

// ---------------------------------------------------------------------------
// Repair 1: Strip null from optional fields
// ---------------------------------------------------------------------------

/**
 * Open models send `null` for optional fields instead of omitting them.
 * TypeBox's optional markers reject null — the field must be absent.
 */
export function stripNullFields(
	input: Record<string, unknown>,
	toolName: string,
): string[] {
	const repairs: string[] = [];
	const targetFields = OPTIONAL_NULL_FIELDS[toolName];

	if (targetFields) {
		for (const key of targetFields) {
			if (key in input && input[key] === null) {
				delete input[key];
				repairs.push(`strip_null:${key}`);
			}
		}
	}

	// Also strip null from any field (catch-all for custom tools)
	for (const key of Object.keys(input)) {
		if (input[key] === null && !targetFields?.includes(key)) {
			delete input[key];
			repairs.push(`strip_null:${key}`);
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Repair 2: Parse stringified JSON arrays
// ---------------------------------------------------------------------------

/**
 * Models emit `["a","b"]` as a JSON *string* instead of an actual array.
 * This happens when the model wraps an array value in quotes during
 * JSON serialization.
 *
 * CRITICAL: We skip fields in CONTENT_FIELDS to avoid corrupting writeFile
 * content or bash commands that happen to be JSON-shaped.
 *
 * This must run BEFORE bare-string-wrap, or `'["a","b"]'` becomes `['["a","b"]']`.
 */
export function parseStringifiedArrays(
	input: Record<string, unknown>,
	toolName: string,
): string[] {
	const repairs: string[] = [];
	const knownArrayFields = ARRAY_FIELDS[toolName] ?? [];

	for (const key of Object.keys(input)) {
		if (CONTENT_FIELDS.has(key)) continue;
		const value = input[key];
		if (typeof value !== "string") continue;

		const trimmed = value.trim();
		if (
			!(trimmed.startsWith("[") && trimmed.endsWith("]")) &&
			!(trimmed.startsWith("{") && trimmed.endsWith("}"))
		) {
			continue;
		}

		// Only parse if this is a known array field OR the string looks
		// like it should be structured data (not a random string that
		// starts with [). Be conservative: if this field isn't in
		// knownArrayFields, only parse when the string is exactly a
		// JSON array (not object).
		const isKnownArray = knownArrayFields.includes(key);
		const looksLikeArray = trimmed.startsWith("[") && trimmed.endsWith("]");
		const looksLikeObject = trimmed.startsWith("{") && trimmed.endsWith("}");

		if (isKnownArray || looksLikeArray || (looksLikeObject && key === "config")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) {
					input[key] = parsed;
					repairs.push(`parse_stringified_array:${key}`);
				}
			} catch {
				// Not valid JSON — leave as-is
			}
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Repair 3: Unwrap single object where array expected
// ---------------------------------------------------------------------------

/**
 * Models wrap a single arg in `{}` where the schema expected an array.
 * Example: `phases: { title: "...", steps: [...] }` instead of
 *          `phases: [{ title: "...", steps: [...] }]`
 *
 * Only applied to known array fields.
 */
export function unwrapSingleObjectAsArray(
	input: Record<string, unknown>,
	toolName: string,
): string[] {
	const repairs: string[] = [];
	const knownArrayFields = ARRAY_FIELDS[toolName] ?? [];

	for (const key of knownArrayFields) {
		const value = input[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			input[key] = [value];
			repairs.push(`unwrap_single_object:${key}`);
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Repair 4: Wrap bare string where array expected
// ---------------------------------------------------------------------------

/**
 * Models pass a bare string where an array was expected.
 * Example: `skill: "caveman"` instead of `skill: ["caveman"]`
 *
 * Only applied to known array fields. Must run AFTER parseStringifiedArrays,
 * or `'["a","b"]'` would become `['["a","b"]']`.
 */
export function wrapBareStringAsArray(
	input: Record<string, unknown>,
	toolName: string,
): string[] {
	const repairs: string[] = [];
	const knownArrayFields = ARRAY_FIELDS[toolName] ?? [];

	for (const key of knownArrayFields) {
		if (typeof input[key] === "string") {
			input[key] = [input[key]];
			repairs.push(`wrap_bare_string:${key}`);
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Repair 5: Strip markdown auto-links from path fields
// ---------------------------------------------------------------------------

/**
 * The funniest and most revealing failure mode: deepseek-flash emits paths as
 * markdown auto-links:
 *
 *   path: "/home/x/proj/[notes.md](http://notes.md)"
 *
 * This is not a hallucination — it's the post-training chat distribution
 * leaking through the tool boundary. The model has been rewarded for
 * auto-linking in conversational output and applies that prior where it
 * makes no sense.
 *
 * Fix: unwrap only the degenerate case where link text equals the URL
 * (minus protocol). Real markdown like `[click](https://x.com)` passes
 * through untouched.
 */
export function stripMarkdownAutoLinks(
	input: Record<string, unknown>,
	toolName: string,
): string[] {
	const repairs: string[] = [];
	const pathFields = PATH_FIELDS[toolName] ?? [];

	for (const key of pathFields) {
		const value = input[key];
		if (typeof value !== "string") continue;

		const newValue = value.replace(DEGENERATE_AUTO_LINK, (match, linkText, url) => {
			// Normalize both by removing whitespace for comparison
			const normalizedText = linkText.replace(/\s+/g, "");
			const normalizedUrl = url.replace(/\s+/g, "").replace(/^https?:\/\//, "");

			// Only unwrap when link text IS the filename (degenerate case)
			if (normalizedText === normalizedUrl || normalizedText.endsWith(normalizedUrl)) {
				return linkText;
			}
			// Real markdown link — pass through untouched
			return match;
		});

		if (newValue !== value) {
			input[key] = newValue;
			repairs.push(`strip_auto_link:${key}`);
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Repair 6: Relational default — read tool offset/limit
// ---------------------------------------------------------------------------

/**
 * read_file had a relational invariant: "if you provide offset, you must also
 * provide limit, and vice versa." Models keep calling
 * `read({ path, limit: 30 })` or `read({ path, offset: 100 })` and getting
 * an error back.
 *
 * You can't fix this with input repair, because each field is independently
 * valid — the bug is in the *relationship* between them. So we teach the
 * function the model's intent instead:
 *
 *   limit alone → offset = 1
 *   offset alone → limit = 2000
 *
 * The default is surfaced back to the model in the result message so it can
 * self-correct on the next turn if our guess was wrong.
 */
export function applyRelationalDefaults(
	toolName: string,
	input: Record<string, unknown>,
): string[] {
	const repairs: string[] = [];

	if (toolName === "read") {
		if (input.offset !== undefined && input.limit === undefined) {
			input.limit = READ_DEFAULT_LIMIT;
			repairs.push("relational_default:limit_from_offset");
		}
		if (input.limit !== undefined && input.offset === undefined) {
			input.offset = READ_DEFAULT_OFFSET;
			repairs.push("relational_default:offset_from_limit");
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Nested object repair (recursive for subagent/plan_create fields)
// ---------------------------------------------------------------------------

/**
 * Some repairs need to apply to nested objects. For example,
 * plan_create.phases is already an array of objects, but each
 * phase.steps might have the same shape issues.
 *
 * Similarly, subagent.chain items can have `parallel` and `reads` arrays,
 * and subagent.tasks items can have `reads` arrays.
 */
export function repairNestedArrayItems(
	input: Record<string, unknown>,
	toolName: string,
): string[] {
	const repairs: string[] = [];

	if (toolName === "plan_create" && Array.isArray(input.phases)) {
		for (const phase of input.phases) {
			if (typeof phase !== "object" || phase === null) continue;

			// steps: might be stringified JSON or a bare string
			if (typeof phase.steps === "string") {
				const trimmed = phase.steps.trim();
				if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
					try {
						const parsed = JSON.parse(trimmed);
						if (Array.isArray(parsed)) {
							phase.steps = parsed;
							repairs.push("nested:parse_stringified_array:phases.steps");
						}
					} catch {
						// not valid JSON
					}
				} else {
					phase.steps = [phase.steps];
					repairs.push("nested:wrap_bare_string:phases.steps");
				}
			}

			// single object where steps array expected
			if (typeof phase.steps === "object" && !Array.isArray(phase.steps)) {
				phase.steps = [phase.steps];
				repairs.push("nested:unwrap_single_object:phases.steps");
			}
		}
	}

	if (toolName === "subagent") {
		// Repair tasks array items
		if (Array.isArray(input.tasks)) {
			for (const task of input.tasks) {
				if (typeof task !== "object" || task === null) continue;
				repairUnsafeArrayFields(task, "tasks", repairs);
				repairPathAutoLinks(task, "tasks", repairs);
			}
		}

		// Repair chain array items
		if (Array.isArray(input.chain)) {
			for (const step of input.chain) {
				if (typeof step !== "object" || step === null) continue;
				repairUnsafeArrayFields(step, "chain", repairs);
				repairPathAutoLinks(step, "chain", repairs);

				// chain[].parallel is an array
				if (typeof step.parallel === "string") {
					const trimmed = step.parallel.trim();
					if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
						try {
							const parsed = JSON.parse(trimmed);
							if (Array.isArray(parsed)) {
								step.parallel = parsed;
								repairs.push("nested:parse_stringified_array:chain.parallel");
							}
						} catch {
							// not valid JSON
						}
					}
				}
			}
		}
	}

	return repairs;
}

// ---------------------------------------------------------------------------
// Helpers for nested array items
// ---------------------------------------------------------------------------

/**
 * Subagent schema has Type.Unsafe fields that accept anyOf: array | boolean | string.
 * These are particularly prone to the bare-string-where-array-expected failure.
 * Fields: skill, reads, output
 */
function repairUnsafeArrayFields(
	item: Record<string, unknown>,
	prefix: string,
	repairs: string[],
): void {
	for (const field of ["reads", "skill"] as const) {
		const value = item[field];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
				try {
					const parsed = JSON.parse(trimmed);
					if (Array.isArray(parsed)) {
						item[field] = parsed;
						repairs.push(`nested:parse_stringified_array:${prefix}.${field}`);
						continue;
					}
				} catch {
					// not valid JSON
				}
			}
			// If it's not JSON-parseable and the field expects
			// anyOf: array|string, a bare string is actually
			// valid per the schema. So we don't wrap it.
		}
	}
}

/**
 * Strip auto-links from path fields in nested objects.
 */
function repairPathAutoLinks(
	item: Record<string, unknown>,
	prefix: string,
	repairs: string[],
): void {
	for (const field of ["cwd"] as const) {
		const value = item[field];
		if (typeof value !== "string") continue;

		const newValue = stripAutoLinksFromValue(value);
		if (newValue !== null) {
			item[field] = newValue;
			repairs.push(`nested:strip_auto_link:${prefix}.${field}`);
		}
	}
}