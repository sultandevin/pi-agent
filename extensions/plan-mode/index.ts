/**
 * Plan Mode Extension
 *
 * Read-only exploration mode that works with PLAN.md as a free-form document.
 * Blocks edit/write tools (except for PLAN.md itself) and restricts bash during planning.
 * Allows ask_user_question in plan mode.
 * The agent reads and writes PLAN.md using normal tools — no structured checklist.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit", "ask_user_question", "subagent", "web_search"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const PLAN_FILE_NAMES = ["PLAN.md", ".pi/plan.md", ".pi/PLAN.md"] as const;
const DEFAULT_PLAN_FILE: string = PLAN_FILE_NAMES[0];

function findPlanFile(cwd: string): string | null {
	for (const name of PLAN_FILE_NAMES) {
		const p = path.join(cwd, name);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

function readPlanContent(planPath: string): string | null {
	try {
		return fs.readFileSync(planPath, "utf-8");
	} catch {
		return null;
	}
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let cwd: string = "";
	let planPath: string | null = null;

	function refreshPlanPath(): void {
		if (!cwd) return;
		const found = findPlanFile(cwd);
		if (found) planPath = found;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan mode"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
		ctx.ui.setWidget("plan-mode", undefined);
	}

	function persistState(): void {
		pi.appendEntry("plan-state", {
			version: 2,
			planModeEnabled,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify("Plan mode enabled. You can read, explore, and write PLAN.md. All other file modifications are blocked.", "info");
		} else {
			pi.setActiveTools(FULL_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full tool access restored.", "info");
		}
		updateUI(ctx);
		persistState();
	}

	// ─── Flag ───
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration, write PLAN.md only)",
		type: "boolean",
		default: false,
	});

	// ─── Command ───
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration, write PLAN.md only)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	// ─── Keyboard Shortcut ───
	pi.registerShortcut(Key.alt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ─── Tool blocker ───
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			const targetPath = event.input?.path as string | undefined;
			if (targetPath && cwd) {
				const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);

				// Allow if target is the known PLAN.md
				if (planPath && resolved === planPath) {
					return;
				}

				// Allow if creating PLAN.md for the first time (any PLAN.md in cwd root)
				if (resolved === path.resolve(cwd, DEFAULT_PLAN_FILE)) {
					return;
				}
			}

			return {
				block: true,
				reason: "Plan mode is active — you cannot modify files other than PLAN.md. Use read, grep, find, ls to explore, and write PLAN.md to document your plan. The user can exit plan mode (Alt+p or /plan) to enable full edits.",
			};
		}
	});

	// ─── Inject plan context before agent starts ───
	pi.on("before_agent_start", async () => {
		refreshPlanPath();

		if (!planPath) return;
		const content = readPlanContent(planPath);
		if (!content) return;

		let message = `[PLAN] The following PLAN.md exists in the project:\n\n${content}\n`;

		if (planModeEnabled) {
			message += `\n[PLAN MODE ACTIVE] You are in plan mode. You can read any file and explore, but you can only write/edit PLAN.md. Focus on understanding the codebase and documenting your approach in PLAN.md. The user must exit plan mode (Alt+p or /plan) for you to make changes to other files.`;
		}

		return {
			message: {
				customType: "plan-context",
				content: message,
				display: false,
			},
		};
	});

	// ─── Restore state on session start / resume / fork ───
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		// Auto-detect PLAN.md
		refreshPlanPath();

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const planStateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-state",
			)
			.pop() as { data?: { planModeEnabled?: boolean } } | undefined;

		if (planStateEntry?.data) {
			planModeEnabled = planStateEntry.data.planModeEnabled ?? planModeEnabled;
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}

		updateUI(ctx);
	});

	// ─── Handle tree navigation ───
	pi.on("session_tree", async (_event, ctx) => {
		cwd = ctx.cwd;

		const entries = ctx.sessionManager.getEntries();
		const planStateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-state",
			)
			.pop() as { data?: { planModeEnabled?: boolean } } | undefined;

		if (planStateEntry?.data) {
			planModeEnabled = planStateEntry.data.planModeEnabled ?? false;
		} else {
			refreshPlanPath();
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		} else {
			pi.setActiveTools(FULL_TOOLS);
		}

		updateUI(ctx);
	});
}