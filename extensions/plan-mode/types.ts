/**
 * Shared types for the plan-mode extension.
 */

export type StepStatus = "pending" | "in-progress" | "done" | "skipped";

export interface Step {
	id: string;
	text: string;
	status: StepStatus;
}

export interface Phase {
	id: string;
	title: string;
	steps: Step[];
}

export interface Plan {
	title: string;
	created: string;
	phases: Phase[];
}

export interface PlanStateEntry {
	version: number;
	planPath: string | null;
	plan: Plan;
}

export interface Frontmatter {
	[key: string]: string;
}

export interface ParsedPlan {
	frontmatter: Frontmatter;
	plan: Plan;
}
