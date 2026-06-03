/**
 * Tool Input Repair Extension — Entry Point
 *
 * Implements the validate-then-repair pattern from the "how we made deepseek
 * outperform opus" playbook. Open models produce a small, finite compositional
 * set of shape failures when calling tools. This extension repairs those
 * failures in the tool_call event before execution, and improves result
 * messages for relational defaults.
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
import { stripNullFields, parseStringifiedArrays, stripMarkdownAutoLinks, unwrapSingleObjectAsArray, wrapBareStringAsArray, repairNestedArrayItems, applyRelationalDefaults } from "./repairs.js";
import { logRepair, repairCounts, repairLog, type RepairEntry } from "./telemetry.js";
import { trackRelationalRepair, improveResult } from "./result.js";

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
			trackRelationalRepair(event.toolCallId, relationalRepairs);
		}

		// Note: event.input is mutated in place.
		// The framework applies mutations without re-validation,
		// which is exactly what we want for repair.
	});

	// ─── Result improvement on tool_result ──────────────────────────

	pi.on("tool_result", (event) => {
		return improveResult(event);
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
				(entry: RepairEntry) =>
					`  [${new Date(entry.ts).toISOString().slice(11, 19)}] ` +
					`${entry.model}/${entry.tool}: ${entry.repairs.join(", ")}`,
			);

			ctx.ui.notify(`Recent repairs (last ${recent.length}):\n${lines.join("\n")}`, "info");
		},
	});
}