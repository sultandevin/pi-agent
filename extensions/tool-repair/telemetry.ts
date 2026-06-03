/**
 * Telemetry for the tool input repair layer.
 *
 * Tracks per-(model, tool, repair-type) counts and a bounded recent
 * log for the repair-stats / repair-log commands.
 */

export interface RepairEntry {
	ts: number;
	model: string;
	tool: string;
	repairs: string[];
}

const MAX_LOG = 1000;

export const repairCounts = new Map<string, number>();
export const repairLog: RepairEntry[] = [];

/**
 * Increment counters for each repair tag and append to the recent log.
 * The log is bounded: when it exceeds MAX_LOG, the oldest half is pruned.
 */
export function logRepair(
	model: string | undefined,
	tool: string,
	repairs: string[],
): void {
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