/**
 * Confirm Destructive Extension
 *
 * Prompts for user confirmation before destructive bash commands and file overwrites.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// ── Destructive command patterns ──
	const dangerousCommandPatterns = [
		// recursive/permanent deletion
		/\brm\s+(-[fr]*|--recursive|--force)/i,
		// sudo (elevated privileges)
		/\bsudo\b/i,
		// overly permissive chmod/chown
		/\b(chmod|chown)\b.*777/i,
		// dd (direct disk writes)
		/\bdd\s+/i,
		// filesystem formatting
		/\bmkfs\b/i,
		// secure deletion / shredding
		/\bshred\s+/i,
		// truncate / empty file with redirection
		/>\s*["']?\/?(\w+\/)*\w+/,
		// database drops
		/\bdrop\s+(database|table|schema)\b/i,
		// git destructive commands
		/\bgit\s+(reset\s+--hard|clean\s+-|push\s+.*--force)\b/i,
		// pipeline with rm
		/\brm\b.*\|/i,
		// rmdir -rf
		/\brmdir\s+-[rp]/i,
	];

	// ── Bash tool interceptor ──
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command: string = event.input.command ?? "";
		const isDangerous = dangerousCommandPatterns.some((p) => p.test(command));

		if (!isDangerous) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked dangerous bash command (no UI for confirmation): ${command}`,
			};
		}

		const confirmed = await ctx.ui.confirm(
			"⚠️  Destructive bash command",
			`Allow?\n\n  ${command}`,
		);

		if (!confirmed) {
			ctx.ui.notify("⛔ Command blocked by user", "error");
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});

	// ── Write tool interceptor (existing file overwrite) ──
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write") return undefined;

		const path: string = event.input.path ?? "";

		// Check if file exists (only works for absolute / resolved paths)
		let exists = false;
		try {
			const fs = await import("node:fs");
			const fullPath = path.startsWith("/")
				? path
				: `${ctx.cwd}/${path}`;
			exists = fs.existsSync(fullPath);
		} catch {
			exists = false;
		}

		if (!exists) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked file overwrite (no UI for confirmation): ${path}`,
			};
		}

		const confirmed = await ctx.ui.confirm(
			"⚠️  File overwrite",
			`"${path}" already exists. Overwrite it?`,
		);

		if (!confirmed) {
			ctx.ui.notify("⛔ Write blocked by user", "error");
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}
