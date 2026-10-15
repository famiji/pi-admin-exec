// Elevation plumbing for pi-admin-exec.
//
// Platform-independent part: buildWrapper / parseResult. A new platform backend
// replaces only the macOS section at the bottom and reuses both.

export const EXIT_MARKER = "__PI_ADMIN_EXIT__";

/**
 * Wrap a command so `/bin/sh <file>` always exits 0 and reports the real status
 * on stdout.
 *
 * Why the indirection: `do shell script` raises an AppleScript error on a
 * non-zero exit and its output is lost, so the wrapper has to swallow the
 * status itself and hand it back as data.
 *
 * The command runs in a subshell for the same reason: a bare `exit` in the
 * command would otherwise end the script before the marker is printed.
 */
export function buildWrapper(command) {
	return [
		"#!/bin/sh",
		"(",
		command,
		") 2>&1",
		"__pi_admin_rc=$?",
		`printf '\\n${EXIT_MARKER}%s\\n' "$__pi_admin_rc"`,
		"exit 0",
		"",
	].join("\n");
}

/** Split a completed wrapper run into `{ output, exitCode }`. */
export function parseResult(raw) {
	const idx = raw.lastIndexOf(EXIT_MARKER);
	if (idx === -1) return { output: raw.replace(/\n+$/, ""), exitCode: null };
	const match = /^__PI_ADMIN_EXIT__(-?\d+)/.exec(raw.slice(idx));
	return {
		// The slice drops the marker and the blank separator line printf writes before it.
		output: raw.slice(0, idx).replace(/\n+$/, ""),
		exitCode: match ? Number(match[1]) : null,
	};
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
