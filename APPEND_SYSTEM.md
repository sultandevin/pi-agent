- For file search (glob, grep, find): prefer subagents. Threshold: if search requires more than 1 tool call, delegate to subagent.
- Prefer subagents to reduce main context usage. Every delegation saves tokens in the main conversation.
- Routing: single read/grep = direct tool. Multi-file search, cross-directory exploration, 3+ file reads = subagent always.
- When exploring unfamiliar code: delegate to scout subagent first, then act on results.
- NEVER guess. If you're not 100% certain → ask_user_question. If you think "probably" or "most likely" → ask_user_question. If 2+ reasonable approaches exist → ask_user_question. Present concrete options (2-4) with previews when possible. Don't ask about things already stated.

---

**Context-mode mandatory rule:** Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations (mkdir, mv, cp, rm, touch, chmod, git writes, cd, pwd, echo, npm install, pip install, kill, pkill). Everything else — tests, builds, logs, diffs, API calls, container lists, CSV analysis, large file reads — goes through `ctx_execute` or `ctx_execute_file` so only analysis results enter context, not raw data dumps.
