/**
 * Plan Viewer overlay component.
 *
 * Read-only display of the current plan with status icons.
 * Escape or Ctrl+C to close.
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Plan } from "./types.js";

const STATUS_ICONS: Record<string, string> = {
	pending: "☐",
	"in-progress": "▶",
	done: "☑",
	skipped: "⊘",
};

export class PlanViewerComponent {
	private plan: Plan;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(plan: Plan, theme: Theme, onClose: () => void) {
		this.plan = plan;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const { done, total } = this.getProgress();

		lines.push("");
		const headerText = ` Plan: ${this.plan.title} `;
		const pad = Math.max(0, width - headerText.length - 4);
		const headerLine = th.fg("borderMuted", "─".repeat(2)) + th.fg("accent", headerText) + th.fg("borderMuted", "─".repeat(pad));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		for (const phase of this.plan.phases) {
			const phaseHeader = th.fg("accent", `▸ ${phase.title}`);
			lines.push(truncateToWidth(phaseHeader, width));

			for (const step of phase.steps) {
				const icon = STATUS_ICONS[step.status] ?? "☐";
				const iconColor =
					step.status === "done"
						? "success"
						: step.status === "in-progress"
							? "warning"
							: step.status === "skipped"
								? "error"
								: "dim";
				const textColor = step.status === "done" || step.status === "skipped" ? "dim" : "text";
				const stepLine =
					`  ${th.fg(iconColor, icon)} ${th.fg("muted", step.id)} ${th.fg(textColor, step.text)}`;
				lines.push(truncateToWidth(stepLine, width));
			}
			lines.push("");
		}

		const progressLine = th.fg("muted", `  ${done}/${total} steps completed`);
		lines.push(truncateToWidth(progressLine, width));
		lines.push("");
		lines.push(truncateToWidth(th.fg("dim", "  Press Escape to close"), width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getProgress(): { done: number; total: number } {
		let done = 0;
		let total = 0;
		for (const phase of this.plan.phases) {
			for (const step of phase.steps) {
				total++;
				if (step.status === "done") done++;
			}
		}
		return { done, total };
	}
}
