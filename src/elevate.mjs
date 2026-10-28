// Elevation plumbing for pi-admin-exec.
//
// Platform-independent part: buildDriver. A new platform backend replaces only
// the macOS section below and reuses it.

/**
 * Build the script that runs as root.
 *
 * It runs `<dir>/cmd.sh` — the user's command, written verbatim, so no shell or
 * AppleScript escaping can mangle it — and leaves files next to it: `out`
 * (merged stdout/stderr), `exit` (the raw status) and `stopped` (why the
 * command was cut short: `deadline`, `parent`, or absent when it finished).
 *
 * Why a driver at all, instead of one shell string:
 *
 * - The status travels out of band, in `exit`. Printing it on stdout would let a
 *   command print the same line, and a truncated read would lose it.
 * - The command runs as a background job so the watchdog can reach its whole
 *   process tree. Killing `osascript` alone leaves that tree running as root —
 *   which is what used to happen on every timeout.
 * - The deadline is enforced *here*, not by the parent, so it also fires when
 *   the parent is gone: Pi's abort (and any crash of Pi) SIGTERMs `osascript`,
 *   which orphans this script but does not stop it. Polling for the original
 *   parent closes that hole.
 */
export function buildDriver(dir, { timeoutSeconds = 900 } = {}) {
	const quoted = dir.replace(/'/g, "'\\''");
	return [
		"#!/bin/sh",
		`__pi_dir='${quoted}'`,
		"",
		"# Stop a process and everything below it. Depth is bounded by the real tree.",
		"# shortcut: one pgrep pass per level; a process that forks during the walk",
		"# survives until the deadline backstop.",
		"kill_tree() {",
		'\tfor c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "$2"; done',
		'\tkill -"$2" "$1" 2>/dev/null',
		"}",
		"",
		"# Merged into one file so stdout and stderr keep their relative order.",
		'/bin/sh "$__pi_dir/cmd.sh" > "$__pi_dir/out" 2>&1 &',
		"__pi_pid=$!",
		"__pi_parent=$PPID",
		`__pi_budget=${timeoutSeconds}`,
		"",
		"# Two reasons to stop the command: the deadline, or Pi going away (polled, so a",
		"# reused pid delays it to the deadline at worst; pid 1 means nobody is left).",
		'\t( __pi_why=deadline',
		'\t  while [ "$__pi_budget" -gt 0 ]; do',
		'\t\tif [ "$__pi_parent" -le 1 ] || ! kill -0 "$__pi_parent" 2>/dev/null; then',
		'\t\t\t__pi_why=parent',
		'\t\t\tbreak',
		'\t\tfi',
		"\t\tsleep 1",
		'\t\t__pi_budget=$((__pi_budget - 1))',
		"\t  done",
		'\t  printf \'%s\\n\' "$__pi_why" > "$__pi_dir/stopped"',
		'\t  kill_tree "$__pi_pid" TERM',
		"\t  __pi_n=0",
		'\t  while kill -0 "$__pi_pid" 2>/dev/null && [ "$__pi_n" -lt 5 ]; do',
		"\t\tsleep 1",
		'\t\t__pi_n=$((__pi_n + 1))',
		"\t  done",
		'\t  kill_tree "$__pi_pid" KILL',
		"\t) &",
		"__pi_wd=$!",
		"",
		'{ wait "$__pi_pid"; } 2>/dev/null',
		"__pi_rc=$?",
		'kill_tree "$__pi_wd" KILL',
		"",
		'printf \'%s\\n\' "$__pi_rc" > "$__pi_dir/exit"',
		"exit 0",
		"",
	].join("\n");
}

// --- macOS backend -----------------------------------------------------------

/**
 * AppleScript that runs `scriptPath` as root behind the native authorization
 * dialog. One `with timeout` block, because AppleScript events time out after
 * two minutes by default and privileged commands are allowed to be slow.
 */
export function macosElevationScript(scriptPath) {
	const shellCommand = `/bin/sh '${scriptPath.replace(/'/g, "'\\''")}'`;
	// AppleScript string literals only treat `\` and `"` as escapes.
	const literal = shellCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return [
		"with timeout of 86400 seconds",
		`do shell script "${literal}" with administrator privileges`,
		"end timeout",
	].join("\n");
}

/**
 * True when osascript failed because the user dismissed the password dialog.
 *
 * Matches the error number rather than the message, because the message is
 * localized ("User canceled." / "用户已取消。").
 */
export function isUserCancel(stderr) {
	return /\(-128\)/.test(stderr ?? "") || /User cancel/i.test(stderr ?? "");
}

// --- audit trail -------------------------------------------------------------

/**
 * One line per attempt, so a root command is never invisible after the fact.
 * Written as JSON Lines and rendered by formatAuditEntry.
 *
 * `outcome` is one of: ran | declined | cancelled | error. Declined and
 * cancelled attempts are recorded too — knowing what was *tried* is the point.
 */
export function auditRecord(command, reason, outcome, { exitCode = null, durationMs = null, ts = new Date().toISOString() } = {}) {
	return { ts, command, reason, outcome, exitCode, durationMs };
}

/** Render one audit entry as the two-line block `/admin` prints. */
export function formatAuditEntry(entry) {
	const status = entry.outcome === "ran" ? `exit ${entry.exitCode ?? "?"}` : entry.outcome;
	const seconds = typeof entry.durationMs === "number" ? ` ${(entry.durationMs / 1000).toFixed(1)}s` : "";
	const reason = entry.reason ? `\n    ${entry.reason}` : "";
	return `${entry.ts}  ${status}${seconds}  ${entry.command}${reason}`;
}

/** Parse a JSON Lines audit log and return the newest `limit` entries. */
export function parseAuditLog(text, limit = 10) {
	const entries = [];
	for (const line of (text ?? "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed.command === "string") entries.push(parsed);
		} catch {
			// A half-written final line (killed mid-append) is not worth failing over.
		}
	}
	return entries.slice(-limit);
}
