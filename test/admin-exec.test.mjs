// The wrapper is plain /bin/sh, so every case here runs without root and
// without touching the macOS authorization dialog.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	auditRecord,
	buildWrapper,
	EXIT_MARKER,
	formatAuditEntry,
	isUserCancel,
	macosElevationScript,
	parseAuditLog,
	parseResult,
} from "../src/elevate.mjs";

/** Run a command through the wrapper, exactly as the tool does. */
function run(command) {
	const dir = mkdtempSync(join(tmpdir(), "pi-admin-test-"));
	const scriptPath = join(dir, "run.sh");
	try {
		writeFileSync(scriptPath, buildWrapper(command), { mode: 0o700 });
		return parseResult(execFileSync("/bin/sh", [scriptPath], { encoding: "utf8" }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("returns the command output", () => {
	assert.deepEqual(run("echo hi"), { output: "hi", exitCode: 0 });
});

test("reports a failing exit code instead of aborting", () => {
	assert.equal(run("exit 3").exitCode, 3);
});

test("a bare exit cannot skip the marker", () => {
	// The command runs in a subshell for exactly this reason.
	assert.equal(run("exit 42").exitCode, 42);
});

test("merges stderr into the output, in order", () => {
	assert.deepEqual(run("echo out; echo err >&2; exit 3"), {
		output: "out\nerr",
		exitCode: 3,
	});
});

test("passes quotes through untouched", () => {
	assert.deepEqual(run("printf '%s\\n' \"a'b\""), { output: "a'b", exitCode: 0 });
});

test("strips the marker", () => {
	assert.equal(run("echo done").output.includes(EXIT_MARKER), false);
});

test("reports an unknown exit code when the marker never arrived", () => {
	assert.deepEqual(parseResult("killed\n"), { output: "killed", exitCode: null });
});

test("the script path survives being embedded in AppleScript", () => {
	// Reproduce what AppleScript hands the shell, then actually run it, for a
	// path containing a quote and a backslash.
	const base = mkdtempSync(join(tmpdir(), "pi-admin-path-"));
	try {
		const dir = join(base, "it's \\ odd");
		mkdirSync(dir, { recursive: true });
		const script = join(dir, "run.sh");
		writeFileSync(script, "echo path-ok\n", { mode: 0o700 });

		const literal = macosElevationScript(script).match(/do shell script "(.*)" with admin/)[1];
		const command = literal.replace(/\\(["\\])/g, "$1"); // AppleScript un-escaping
		assert.equal(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).trim(), "path-ok");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("recognizes a cancelled dialog in any language", () => {
	assert.equal(isUserCancel("execution error: User canceled. (-128)"), true);
	assert.equal(isUserCancel("execution error: 用户已取消。(-128)"), true);
	assert.equal(isUserCancel(""), false);
});

test("an audit record carries the command, the reason and the outcome", () => {
	assert.deepEqual(
		auditRecord("rm -rf /tmp/x", "clean up", "ran", { exitCode: 0, durationMs: 1500, ts: "T" }),
		{ ts: "T", command: "rm -rf /tmp/x", reason: "clean up", outcome: "ran", exitCode: 0, durationMs: 1500 },
	);
});

test("a declined attempt is recorded too", () => {
	// Knowing what was tried is the point of the log.
	assert.equal(auditRecord("id", "check", "declined").outcome, "declined");
});

test("formats a run with its exit code, duration and reason", () => {
	assert.equal(
		formatAuditEntry(auditRecord("id -u", "check", "ran", { exitCode: 0, durationMs: 1200, ts: "T" })),
		"T  exit 0 1.2s  id -u\n    check",
	);
});

test("formats a non-run outcome without a duration", () => {
	assert.equal(
		formatAuditEntry(auditRecord("id -u", "", "cancelled", { ts: "T" })),
		"T  cancelled  id -u",
	);
});

test("reads back only the newest entries", () => {
	const log = ["a", "b", "c"]
		.map((command) => JSON.stringify(auditRecord(command, "", "ran", { exitCode: 0 })))
		.join("\n");
	assert.deepEqual(
		parseAuditLog(log, 2).map((entry) => entry.command),
		["b", "c"],
	);
});

test("skips blank and half-written lines instead of failing", () => {
	const good = JSON.stringify(auditRecord("id", "", "ran", { exitCode: 0 }));
	assert.deepEqual(
		parseAuditLog(`\n${good}\n{"ts":"T","comm`, 5).map((entry) => entry.command),
		["id"],
	);
});

// --- end of audit cases
