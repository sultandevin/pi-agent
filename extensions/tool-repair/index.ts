/**
 * Tool Input Repair Layer
 *
 * Implements the validate-then-repair pattern from the "how we made deepseek
 * outperform opus" playbook. Open models (deepseek, glm, qwen, kimi, minimax)
 * produce a small, finite compositional set of shape failures when calling
 * tools. This extension repairs those failures in the tool_call event before
 * execution, and improves result messages for relational defaults.
 *
 * Integration points:
 *   - `tool_call` event: event.input is mutable in-place before execution.
 *     The framework applies mutations without re-validation, so repair order
 *     matters (json-array-parse before bare-string-wrap).
 *   - `tool_result` event: can modify content and isError flag after execution.
 *     Used to surface relational defaults as notes instead of errors.
 *
 * Architecture note: the blog post's author first tried preprocessing, and it
 * silently corrupted writeFile content that happened to be JSON-shaped. The
 * correct pattern is to use the validator's issue list to localize repairs.
 * But the pi framework's tool_call event fires before validation, and
 * `event.input` mutations bypass re-validation. So we approximate the
 * validate-then-repair pattern by being surgical — each repair targets a
 * specific known failure mode on specific known fields, rather than greedily
 * normalizing everything.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Known field classifications per tool
// ---------------------------------------------------------------------------

/**
 * Fields where the model might emit a stringified JSON array '["a","b"]'
 * instead of an actual array.
 *
 * IMPORTANT: "content" and "command" are deliberately excluded. writeFile
 * content that happens to be JSON-shaped would be silently corrupted if we
 * parsed it. bash commands are arbitrary strings.
 */
const ARRAY_FIELDS: Record<string, string[]> = {
	// Custom tools
	plan_create: ["phases"],
	subagent: ["tasks", "chain"],
	// Within nested objects (handled recursively):
	//   plan_create.phases[].steps
	//   subagent.tasks[].reads
	//   subagent.chain[].parallel
	//   subagent.chain[].reads
};

/**
 * Fields that contain filesystem paths. These are the ones where
 * markdown auto-links leak through. The model has been rewarded for
 * auto-linking in chat output and applies that prior in tool contexts.
 */
const PATH_FIELDS: Record<string, string[]> = {
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	bash: [], // command is NOT a path
	grep: ["path"],
	find: ["path"],
	ls: ["path"],
	plan_create: [],
	plan_step: [],
	subagent: ["cwd"],
	web_search: [],
	web_fetch: ["url"],
};

/**
 * Fields whose string content should NEVER be parsed as JSON.
 * This prevents the silent-corruption the blog post warned about.
 */
const CONTENT_FIELDS = new Set(["content", "command", "oldText", "newText", "task", "query"]);

/**
 * Optional numeric fields where the model might send null instead of omitting.
 */
const OPTIONAL_NULL_FIELDS: Record<string, string[]> = {
	read: ["offset", "limit"],
	bash: ["timeout"],
	grep: ["limit", "context"],
	find: ["limit"],
	ls: ["limit"],
	web_search: ["max_results"],
};

// ---------------------------------------------------------------------------
// Repair 1: Strip null from optional fields
// ---------------------------------------------------------------------------

/**
 * Open models send `null` for optional fields instead of omitting them.
 * TypeBox's optional markers reject null — the field must be absent.
 */
function stripNullFields(input: Record<string, unknown>, toolName: string): string[] {
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
function parseStringifiedArrays(input: Record<string, unknown>, toolName: string): string[] {
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
function unwrapSingleObjectAsArray(input: Record<string, unknown>, toolName: string): string[] {
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
function wrapBareStringAsArray(input: Record<string, unknown>, toolName: string): string[] {
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
const DEGENERATE_AUTO_LINK = /\[([^\]]+)\]\(https?:\/\/([^\)]+)\)/g;

function stripMarkdownAutoLinks(input: Record<string, unknown>, toolName: string): string[] {
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

/** Default limit when offset is provided without limit. */
const READ_DEFAULT_LIMIT = 2000;
/** Default offset when limit is provided without offset. */
const READ_DEFAULT_OFFSET = 1;

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
function applyRelationalDefaults(toolName: string, input: Record<string, unknown>): string[] {
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
function repairNestedArrayItems(
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

		const newValue = value.replace(DEGENERATE_AUTO_LINK, (match, linkText, url) => {
			const normalizedText = linkText.replace(/\s+/g, "");
			const normalizedUrl = url.replace(/\s+/g, "").replace(/^https?:\/\//, "");
			if (normalizedText === normalizedUrl || normalizedText.endsWith(normalizedUrl)) {
				return linkText;
			}
			return match;
		});

		if (newValue !== value) {
			item[field] = newValue;
			repairs.push(`nested:strip_auto_link:${prefix}.${field}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

interface RepairEntry {
	ts: number;
	model: string;
	tool: string;
	repairs: string[];
}

const repairCounts = new Map<string, number>();
const repairLog: RepairEntry[] = [];
const MAX_LOG = 1000;

function logRepair(model: string | undefined, tool: string, repairs: string[]): void {
	const modelKey = model ?? "unknown";
	for (const repair of repairs) {
		const key = `${modelKey}:${tool}:${repair}`;
		repairCounts.set(key, (repairCounts.get(key) ?? 0) + 1);
	}

	repairLog.push({ ts: Date.now(), model: modelKey, tool, repairs });
	if (repairLog.length > MAX_LOG) {
		repairLog.splice(0, repairLog.length - Math.floor(MAX_LOG / 2));
	}
}

// ---------------------------------------------------------------------------
// Result message improvement
// ---------------------------------------------------------------------------

/**
 * When we applied relational defaults (offset/limit), we want to surface
 * that information to the model in the result. But we don't want the TUI
 * to paint it red (which `ERROR:` prefix does). So for auto-repaired reads,
 * we add an informational note.
 *
 * We track which toolCallIds had relational repairs so we can improve their
 * results without modifying unrelated results.
 */
const relationalRepairCalls = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function toolRepairExtension(pi: ExtensionAPI): void {
	let currentModel: string | undefined;

	pi.on("model_select", (event) => {
		currentModel = event.model.id;
	});

	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model?.id;
	});

	// ─── Validate-then-repair on tool_call ───────────────────────────

	pi.on("tool_call", (event) => {
		const input = event.input as Record<string, unknown>;
		if (!input || typeof input !== "object") return;

		const allRepairs: string[] = [];

		// Phase 1: Shape repairs (ORDER MATTERS!)
		// json-array-parse must run before bare-string-wrap

		// 1a. Strip null from optional fields
		allRepairs.push(...stripNullFields(input, event.toolName));

		// 1b. Parse stringified JSON arrays (before bare-string-wrap)
		allRepairs.push(...parseStringifiedArrays(input, event.toolName));

		// 1c. Strip markdown auto-links from path fields
		allRepairs.push(...stripMarkdownAutoLinks(input, event.toolName));

		// 1d. Unwrap single object where array expected
		allRepairs.push(...unwrapSingleObjectAsArray(input, event.toolName));

		// 1e. Wrap bare string where array expected (after parseStringifiedArrays!)
		allRepairs.push(...wrapBareStringAsArray(input, event.toolName));

		// Phase 2: Nested object repairs
		allRepairs.push(...repairNestedArrayItems(input, event.toolName));

		// Phase 3: Relational defaults
		const relationalRepairs = applyRelationalDefaults(event.toolName, input);
		allRepairs.push(...relationalRepairs);

		// Phase 4: Telemetry
		if (allRepairs.length > 0) {
			logRepair(currentModel, event.toolName, allRepairs);
		}

		// Track relational repairs for result improvement
		if (relationalRepairs.length > 0) {
			relationalRepairCalls.set(event.toolCallId, relationalRepairs);
		}

		// Note: event.input is mutated in place.
		// The framework applies mutations without re-validation,
		// which is exactly what we want for repair.
	});

	// ─── Result improvement on tool_result ──────────────────────────

	pi.on("tool_result", (event) => {
		const relationalRepairs = relationalRepairCalls.get(event.toolCallId);
		if (!relationalRepairs || relationalRepairs.length === 0) return undefined;

		relationalRepairCalls.delete(event.toolCallId);

		// For read tool with offset/limit relational defaults, append
		// a note to the result so the model knows what defaults were applied
		if (event.toolName === "read") {
			const notes: string[] = [];
			const input = event.input as Record<string, unknown>;

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
						...event.content,
						{ type: "text" as const, text: notes.join("\n") },
					],
				};
			}
		}

		return undefined;
	});

	// ─── Commands ──────────────────────────────────────────────────

	pi.registerCommand("repair-stats", {
		description: "Show tool input repair statistics (per model+tool)",
		handler: async (_args, ctx) => {
			if (repairCounts.size === 0) {
				ctx.ui.notify("No tool input repairs recorded this session.", "info");
				return;
			}

			// Group by model+tool
			const byModelTool = new Map<string, Map<string, number>>();
			for (const [key, count] of repairCounts) {
				const [model, tool, ...repairParts] = key.split(":");
				const repair = repairParts.join(":");
				const modelToolKey = `${model} / ${tool}`;
				if (!byModelTool.has(modelToolKey)) {
					byModelTool.set(modelToolKey, new Map());
				}
				const inner = byModelTool.get(modelToolKey)!;
				inner.set(repair, (inner.get(repair) ?? 0) + count);
			}

			const lines: string[] = ["Tool input repairs this session:", ""];

			for (const [modelTool, repairs] of byModelTool) {
				lines.push(`  ${modelTool}`);
				for (const [repair, count] of repairs) {
					lines.push(`    ${repair}: ${count}`);
				}
			}

			lines.push("");
			lines.push(`  Total: ${repairLog.length} repaired calls`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("repair-log", {
		description: "Show recent tool input repair log entries",
		handler: async (_args, ctx) => {
			if (repairLog.length === 0) {
				ctx.ui.notify("No repair log entries.", "info");
				return;
			}

			const recent = repairLog.slice(-20);
			const lines = recent.map(
				(entry) =>
					`  [${new Date(entry.ts).toISOString().slice(11, 19)}] ` +
					`${entry.model}/${entry.tool}: ${entry.repairs.join(", ")}`,
			);

			ctx.ui.notify(`Recent repairs (last ${recent.length}):\n${lines.join("\n")}`, "info");
		},
	});
}