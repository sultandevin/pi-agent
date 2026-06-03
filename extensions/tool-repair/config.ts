/**
 * Field classification maps and constants for the tool input repair layer.
 *
 * These are pure data — lookup tables that tell the repair functions which
 * fields are safe to transform. Keeping them in one place makes it trivial
 * to add new tools or new failure-mode classifications.
 */

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
export const ARRAY_FIELDS: Record<string, string[]> = {
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
export const PATH_FIELDS: Record<string, string[]> = {
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
export const CONTENT_FIELDS = new Set([
	"content",
	"command",
	"oldText",
	"newText",
	"task",
	"query",
]);

/**
 * Optional numeric fields where the model might send null instead of omitting.
 */
export const OPTIONAL_NULL_FIELDS: Record<string, string[]> = {
	read: ["offset", "limit"],
	bash: ["timeout"],
	grep: ["limit", "context"],
	find: ["limit"],
	ls: ["limit"],
	web_search: ["max_results"],
};

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

/**
 * Matches markdown auto-links: [text](url)
 *
 * Used to unwrap the degenerate case where the model emits a path as
 * an auto-link, e.g. `/Users/x/proj/[notes.md](http://notes.md)`.
 */
export const DEGENERATE_AUTO_LINK =
	/\[([^\]]+)\]\(https?:\/\/([^\)]+)\)/g;

// ---------------------------------------------------------------------------
// Relational default constants
// ---------------------------------------------------------------------------

/** Default limit when offset is provided without limit. */
export const READ_DEFAULT_LIMIT = 2000;

/** Default offset when limit is provided without offset. */
export const READ_DEFAULT_OFFSET = 1;