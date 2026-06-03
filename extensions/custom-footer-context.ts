/**
 * Custom Footer with Context Tokens + Percentage
 *
 * Replaces the built-in footer to show context as "24k/128k (19%)"
 * alongside other footer elements. Always active.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function renderFooter(
	ctx: ExtensionContext,
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
): Component & { dispose?(): void } {
	const branch = footerData.getGitBranch();
	const statuses = footerData.getExtensionStatuses();

	// Format helper
	const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

	// Collect token & cost stats from session
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cacheRead += m.usage.cacheRead ?? 0;
			cacheWrite += m.usage.cacheWrite ?? 0;
			cost += m.usage.cost.total ?? 0;
		}
	}

	// Context usage
	const contextUsage = ctx.getContextUsage();
	const contextText = contextUsage && contextUsage.tokens != null && contextUsage.percent != null
		? `${fmt(contextUsage.tokens)}/${fmt(ctx.model?.contextWindow ?? 128000)} (${Math.round(contextUsage.percent)}%)`
		: "";

	const contextColor = contextUsage && contextUsage.percent != null
		? (contextUsage.percent >= 80 ? "error" : contextUsage.percent >= 50 ? "warning" : "dim")
		: "dim";

	// Session name
	const sessionName = ctx.sessionManager.getSessionName?.() ?? "";

	// Working directory (shorten)
	const cwd = ctx.cwd?.replace(/^\/home\/[^/]+/, "~") ?? "";

	// Model
	const modelName = ctx.model?.name ?? ctx.model?.id ?? "no-model";

	// Extension statuses (e.g. plan-mode)
	const statusTexts = Array.from(statuses.values());
	const statusStr = statusTexts.length > 0 ? ` ${statusTexts.join(" ")}` : "";

	// Build left and right sections
	const tokenStr = `↑${fmt(input)} ↓${fmt(output)}${cacheRead > 0 ? ` ¤${fmt(cacheRead)}` : ""}${cacheWrite > 0 ? ` ○${fmt(cacheWrite)}` : ""}`;
	const costStr = cost > 0 ? ` $${cost.toFixed(3)}` : "";

	const leftBase = `${cwd}${sessionName ? ` · ${sessionName}` : ""}${branch ? ` (${branch})` : ""}`;
	const centerBase = `${tokenStr}${costStr}`;

	return {
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const left = theme.fg("dim", leftBase);
			const center = theme.fg("dim", centerBase);
			const right = contextText
			? theme.fg(contextColor, contextText) + theme.fg("dim", ` · ${modelName}${statusStr}`)
			: theme.fg("dim", `${modelName}${statusStr}`);

			const leftW = visibleWidth(left);
			const centerW = visibleWidth(center);
			const rightW = visibleWidth(right);

			// If too wide, truncate left first, then omit center
			const totalStatic = leftW + centerW + rightW;
			let line = "";

			if (totalStatic <= width) {
				// Pad center between left and right
				const pad = " ".repeat(width - totalStatic);
				line = left + center + pad + right;
			} else if (leftW + rightW <= width) {
				// Drop center, keep left and right
				const pad = " ".repeat(width - leftW - rightW);
				line = left + pad + right;
			} else if (rightW <= width) {
				// Just right side
				line = truncateToWidth(right, width);
			} else {
				line = truncateToWidth(right, width);
			}

			return [line];
		},
	};
}

export default function (pi: ExtensionAPI) {
	let lastCtx: ExtensionContext | null = null;

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => renderFooter(ctx, tui, theme, footerData));
	}

	// Re-render on events that change footer data
	pi.on("session_start", async (_event, ctx) => installFooter(ctx));
	pi.on("session_tree", async (_event, ctx) => installFooter(ctx));
	pi.on("turn_end", async (_event, ctx) => installFooter(ctx));
	pi.on("message_end", async (_event, ctx) => installFooter(ctx));
	pi.on("model_select", async (_event, ctx) => installFooter(ctx));

	// Eager update when extension statuses change (e.g. plan mode toggle)
	pi.events.on("footer:refresh", () => {
		if (lastCtx) installFooter(lastCtx);
	});
}