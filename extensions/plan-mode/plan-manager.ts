/**
 * Plan file parser and state manager.
 *
 * Reads/writes PLAN.md with YAML frontmatter and markdown body.
 * Body format:
 *   ## Phase Title
 *   - [ ] step text
 *   - [x] completed step
 *   - [~] in-progress step
 *   - [-] skipped step
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Frontmatter, ParsedPlan, Plan, Phase, Step, StepStatus } from "./types.js";

const STATUS_MARKERS: Record<StepStatus, string> = {
	pending: " ",
	"in-progress": "~",
	done: "x",
	skipped: "-",
};

function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
	const frontmatter: Frontmatter = {};
	if (!text.startsWith("---\n")) {
		return { frontmatter, body: text };
	}
	const end = text.indexOf("\n---", 4);
	if (end === -1) {
		return { frontmatter, body: text };
	}
	const yamlText = text.slice(4, end);
	const body = text.slice(end + 4).replace(/^\n+/, "");
	for (const line of yamlText.split("\n")) {
		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (match) {
			frontmatter[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
		}
	}
	return { frontmatter, body };
}

function parseStatus(marker: string): StepStatus {
	switch (marker) {
		case "x":
			return "done";
		case "~":
			return "in-progress";
		case "-":
			return "skipped";
		default:
			return "pending";
	}
}

function serializeFrontmatter(frontmatter: Frontmatter): string {
	const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: "${v}"`);
	if (lines.length === 0) return "";
	return `---\n${lines.join("\n")}\n---\n\n`;
}

export function parsePlan(text: string): ParsedPlan {
	const { frontmatter, body } = parseFrontmatter(text);
	const phases: Phase[] = [];
	let currentPhase: Phase | null = null;
	let stepCounter = 0;

	for (const line of body.split("\n")) {
		const phaseMatch = line.match(/^##\s+(.+)$/);
		if (phaseMatch) {
			currentPhase = {
				id: `phase-${phases.length + 1}`,
				title: phaseMatch[1].trim(),
				steps: [],
			};
			phases.push(currentPhase);
			continue;
		}

		const stepMatch = line.match(/^\s*-\s*\[([ x~-])\]\s*(.+)$/);
		if (stepMatch && currentPhase) {
			stepCounter++;
			currentPhase.steps.push({
				id: `${phases.length}.${currentPhase.steps.length + 1}`,
				text: stepMatch[2].trim(),
				status: parseStatus(stepMatch[1]),
			});
		}
	}

	const plan: Plan = {
		title: frontmatter.title ?? "Untitled Plan",
		created: frontmatter.created ?? new Date().toISOString(),
		phases,
	};

	return { frontmatter, plan };
}

export function serializePlan(plan: Plan, frontmatter?: Frontmatter): string {
	const fm: Frontmatter = {
		...frontmatter,
		title: plan.title,
		created: plan.created,
	};
	let out = serializeFrontmatter(fm);
	for (const phase of plan.phases) {
		out += `## ${phase.title}\n`;
		for (const step of phase.steps) {
			const marker = STATUS_MARKERS[step.status] ?? " ";
			out += `- [${marker}] ${step.text}\n`;
		}
		out += "\n";
	}
	return out;
}

export function findPlanFile(cwd: string): string | null {
	const names = ["PLAN.md", ".pi/plan.md", ".pi/PLAN.md"];
	for (const name of names) {
		const p = path.join(cwd, name);
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return null;
}

export class PlanManager {
	plan: Plan | null = null;
	planPath: string | null = null;
	frontmatter: Frontmatter = {};

	load(cwd: string): boolean {
		const p = findPlanFile(cwd);
		if (!p) {
			this.plan = null;
			this.planPath = null;
			return false;
		}
		this.planPath = p;
		const text = fs.readFileSync(p, "utf-8");
		const parsed = parsePlan(text);
		this.plan = parsed.plan;
		this.frontmatter = parsed.frontmatter;
		return true;
	}

	loadFromPath(p: string): boolean {
		if (!fs.existsSync(p)) {
			return false;
		}
		this.planPath = p;
		const text = fs.readFileSync(p, "utf-8");
		const parsed = parsePlan(text);
		this.plan = parsed.plan;
		this.frontmatter = parsed.frontmatter;
		return true;
	}

	save(): void {
		if (!this.plan || !this.planPath) return;
		fs.writeFileSync(this.planPath, serializePlan(this.plan, this.frontmatter), "utf-8");
	}

	getStep(id: string): Step | null {
		if (!this.plan) return null;
		for (const phase of this.plan.phases) {
			for (const step of phase.steps) {
				if (step.id === id) return step;
			}
		}
		return null;
	}

	setStepStatus(id: string, status: StepStatus): boolean {
		const step = this.getStep(id);
		if (!step) return false;
		step.status = status;
		this.save();
		return true;
	}

	getProgress(): { done: number; inProgress: number; total: number } {
		if (!this.plan) return { done: 0, inProgress: 0, total: 0 };
		let done = 0;
		let inProgress = 0;
		let total = 0;
		for (const phase of this.plan.phases) {
			for (const step of phase.steps) {
				total++;
				if (step.status === "done") done++;
				if (step.status === "in-progress") inProgress++;
			}
		}
		return { done, inProgress, total };
	}

	getSummary(): string {
		if (!this.plan) return "No plan loaded.";
		const { done, inProgress, total } = this.getProgress();
		const pending = total - done - inProgress;
		return `${done}/${total} done, ${inProgress} in-progress, ${pending} pending`;
	}
}
