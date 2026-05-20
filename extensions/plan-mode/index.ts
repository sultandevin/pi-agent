/**
 * Plan Mode Extension
 *
 * Read-only exploration mode that writes plans to PLAN.md.
 * Blocks edit/write tools and restricts bash during planning.
 * Provides a Plan Viewer overlay and live progress widgets.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as path from "node:path";
import { PlanManager, findPlanFile } from "./plan-manager.js";
import { PlanViewerComponent } from "./plan-ui.js";
import { isSafeCommand } from "./utils.js";
import type { Plan, StepStatus } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	const planManager = new PlanManager();

	function updateUI(ctx: ExtensionContext): void {
		if (!planManager.plan) {
			ctx.ui.setStatus(
				"plan-mode",
				planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan mode") : undefined,
			);
			ctx.ui.setWidget("plan-mode", undefined);
			return;
		}

		const { done, inProgress, total } = planManager.getProgress();
		const pending = total - done - inProgress;

		if (planModeEnabled) {
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("warning", `⏸ plan | ${done}/${total} done (${pending} pending)`),
			);
		} else {
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `📋 ${done}/${total} done, ${inProgress} in-progress`),
			);
		}

		// Compact widget: one line per phase with status icons
		const lines: string[] = [];
		for (const phase of planManager.plan.phases) {
			const bar = phase.steps
				.map((s) => {
					if (s.status === "done") return ctx.ui.theme.fg("success", "☑");
					if (s.status === "in-progress") return ctx.ui.theme.fg("warning", "~");
					if (s.status === "skipped") return ctx.ui.theme.fg("error", "⊘");
					return ctx.ui.theme.fg("dim", "☐");
				})
				.join("");
			const label = `${truncateToWidth(phase.title, 20)} ${bar}`;
			lines.push(label);
		}
		ctx.ui.setWidget("plan-mode", lines);
	}

	function persistState(): void {
		pi.appendEntry("plan-state", {
			version: 1,
			planModeEnabled,
			planPath: planManager.planPath,
			plan: planManager.plan,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		if (planModeEnabled) {
			pi.setActiveTools(READ_ONLY_TOOLS);
			ctx.ui.notify("Plan mode enabled. edit/write are blocked. Bash is restricted to read-only commands.", "info");
		} else {
			pi.setActiveTools(FULL_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full tool access restored.", "info");
		}
		updateUI(ctx);
		persistState();
	}

	// ─── Flag ───
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ─── Commands ───
	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-view", {
		description: "Open the Plan Viewer overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("plan-view requires interactive mode", "error");
				return;
			}
			if (!planManager.plan) {
				ctx.ui.notify("No plan loaded. Use plan_create or /plan-load first.", "error");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new PlanViewerComponent(planManager.plan!, theme, () => done());
			});
		},
	});

	pi.registerCommand("plan-load", {
		description: "Load a plan file (default: PLAN.md)",
		handler: async (args, ctx) => {
			const filePath = args?.trim() || findPlanFile(ctx.cwd) || path.join(ctx.cwd, "PLAN.md");
			if (planManager.loadFromPath(filePath)) {
				ctx.ui.notify(`Loaded plan: ${planManager.plan?.title}`, "info");
				updateUI(ctx);
				persistState();
			} else {
				ctx.ui.notify(`Plan file not found: ${filePath}`, "error");
			}
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (!planManager.plan) {
				ctx.ui.notify("No plan loaded.", "info");
				return;
			}
			ctx.ui.notify(planManager.getSummary(), "info");
		},
	});

	// ─── Keyboard Shortcut ───
	pi.registerShortcut(Key.alt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ─── Tools ───
	pi.registerTool({
		name: "plan_create",
		label: "Plan Create",
		description: "Create a new plan and write it to PLAN.md. Use this in plan mode to structure your approach before making changes.",
		parameters: Type.Object({
			title: Type.String({ description: "Plan title" }),
			phases: Type.Array(
				Type.Object({
					title: Type.String({ description: "Phase title" }),
					steps: Type.Array(Type.String({ description: "Step description" })),
				}),
				{ description: "Phases with steps" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planPath = path.join(ctx.cwd, "PLAN.md");
			planManager.planPath = planPath;
			planManager.frontmatter = {};
			planManager.plan = {
				title: params.title,
				created: new Date().toISOString(),
				phases: params.phases.map((p, i) => ({
					id: `phase-${i + 1}`,
					title: p.title,
					steps: p.steps.map((s, j) => ({
						id: `${i + 1}.${j + 1}`,
						text: s,
						status: "pending" as StepStatus,
					})),
				})),
			};
			planManager.save();
			persistState();
			updateUI(ctx);

			return {
				content: [
					{
						type: "text",
						text: `Created plan "${params.title}" with ${params.phases.length} phases and ${params.phases.reduce((sum, p) => sum + p.steps.length, 0)} steps at ${planPath}.`,
					},
				],
				details: { planPath, phases: params.phases.length },
			};
		},
	});

	pi.registerTool({
		name: "plan_step",
		label: "Plan Step",
		description: "Update the status of a plan step by its ID (e.g., 1.2, 2.1). Use during execution to track progress.",
		parameters: Type.Object({
			step_id: Type.String({ description: "Step ID, e.g., 1.2 or 2.1" }),
			status: StringEnum(["start", "complete", "skip"] as const),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planManager.plan) {
				return {
					content: [{ type: "text", text: "No plan loaded. Create one first with plan_create." }],
					details: { error: "no plan" },
				};
			}

			let stepStatus: StepStatus;
			switch (params.status) {
				case "start":
					stepStatus = "in-progress";
					break;
				case "complete":
					stepStatus = "done";
					break;
				case "skip":
					stepStatus = "skipped";
					break;
				default:
					stepStatus = "pending";
			}

			if (!planManager.setStepStatus(params.step_id, stepStatus)) {
				return {
					content: [{ type: "text", text: `Step ${params.step_id} not found in plan.` }],
					details: { error: "step not found", stepId: params.step_id },
				};
			}

			persistState();
			updateUI(ctx);

			return {
				content: [{ type: "text", text: `Step ${params.step_id} marked as ${stepStatus}.` }],
				details: { stepId: params.step_id, status: stepStatus },
			};
		},
	});

	// ─── Events ───

	// Block destructive tools and bash in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: "Plan mode active: file modifications (edit/write) are disabled. Run /plan to disable plan mode first.",
			};
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: bash command blocked (not on read-only allowlist).\nCommand: ${command}`,
				};
			}
		}
	});

	// Inject plan context before agent starts
	pi.on("before_agent_start", async () => {
		if (!planManager.plan) return;

		const { done, inProgress, total } = planManager.getProgress();
		const pending = planManager.plan.phases
			.flatMap((p) => p.steps)
			.filter((s) => s.status === "pending");
		const active = planManager.plan.phases
			.flatMap((p) => p.steps)
			.filter((s) => s.status === "in-progress");

		let content = `[PLAN STATUS: ${done}/${total} done, ${inProgress} in-progress]\n\n`;
		content += `Plan: ${planManager.plan.title}\n\n`;

		if (active.length > 0) {
			content += `In progress:\n${active.map((s) => `- ${s.id}: ${s.text}`).join("\n")}\n\n`;
		}

		if (pending.length > 0) {
			content += `Pending:\n${pending.slice(0, 8).map((s) => `- ${s.id}: ${s.text}`).join("\n")}\n`;
			if (pending.length > 8) {
				content += `... and ${pending.length - 8} more pending steps\n`;
			}
		}

		if (planModeEnabled) {
			content += `\n[PLAN MODE ACTIVE] You are in read-only mode. Use read, bash, grep, find, ls only. No edits.\n`;
		}

		return {
			message: {
				customType: "plan-context",
				content,
				display: false,
			},
		};
	});

	// Restore state on session start / resume / fork
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		// Auto-load PLAN.md if present
		if (planManager.load(ctx.cwd)) {
			ctx.ui.notify(`Loaded plan: ${planManager.plan?.title}`, "info");
		}

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const planStateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-state",
			)
			.pop() as
				| { data?: { planModeEnabled?: boolean; planPath?: string | null; plan?: Plan } }
				| undefined;

		if (planStateEntry?.data) {
			planModeEnabled = planStateEntry.data.planModeEnabled ?? planModeEnabled;
			if (planStateEntry.data.plan) {
				planManager.plan = planStateEntry.data.plan;
				planManager.planPath = planStateEntry.data.planPath ?? null;
			}
		}

		if (planModeEnabled) {
			pi.setActiveTools(READ_ONLY_TOOLS);
		}

		updateUI(ctx);
	});

	// Also handle tree navigation
	pi.on("session_tree", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planStateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-state",
			)
			.pop() as
				| { data?: { planModeEnabled?: boolean; planPath?: string | null; plan?: Plan } }
				| undefined;

		if (planStateEntry?.data) {
			planModeEnabled = planStateEntry.data.planModeEnabled ?? false;
			if (planStateEntry.data.plan) {
				planManager.plan = planStateEntry.data.plan;
				planManager.planPath = planStateEntry.data.planPath ?? null;
			}
		} else {
			planManager.load(ctx.cwd);
		}

		if (planModeEnabled) {
			pi.setActiveTools(READ_ONLY_TOOLS);
		} else {
			pi.setActiveTools(FULL_TOOLS);
		}

		updateUI(ctx);
	});
}
