// The driver is plain /bin/sh and reads its exit status from a file, so every
// case here runs without root and without touching the authorization dialog.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	auditRecord,
	buildDriver,
	formatAuditEntry,
	isUserCancel,
	macosElevationScript,
	parseAuditLog,
} from "../src/elevate.mjs";

/** Set up one call's directory: the user's command plus the driver. */
function call(command, options) {
	const dir = mkdtempSync(join(tmpdir(), "pi-admin-test-"));
	writeFileSync(join(dir, "cmd.sh"), `${command}\n`, { mode: 0o600 });
	writeFileSync(join(dir, "driver.sh"), buildDriver(dir, options), { mode: 0o700 });
	return {
		dir,
		run: () => execFileSync("/bin/sh", [join(dir, "driver.sh")], { encoding: "utf8" }),
		read: (name) => readFileSync(join(dir, name), "utf8"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killQuietly(pid) {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/** Run a command through the driver and report `{ output, exitCode }`. */
function run(command, options) {
	const c = call(command, options);
	try {
		c.run();
		return { output: c.read("out").replace(/\n+$/, ""), exitCode: Number(c.read("exit").trim()) };
	} finally {
		c.cleanup();
	}
}

test("returns the command output", () => {
	assert.deepEqual(run("echo hi"), { output: "hi", exitCode: 0 });
});

test("reports a failing exit code instead of aborting", () => {
	assert.equal(run("exit 3").exitCode, 3);
});

test("a command cannot forge the exit status", () => {
	// The status is written by the driver, not printed by the command.
	assert.deepEqual(run("echo __PI_ADMIN_EXIT__7; exit 0"), {
		output: "__PI_ADMIN_EXIT__7",
		exitCode: 0,
	});
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

test("passes a here-doc through untouched", () => {
	assert.equal(run("cat <<'EOF'\n$HOME 'quoted' \"double\"\nEOF").output, "$HOME 'quoted' \"double\"");
});

test("reports the shell's own failure when the command has a syntax error", () => {
	// This used to arrive as "osascript refused the request".
	const result = run('echo "unterminated');
	assert.equal(result.exitCode, 2);
	assert.match(result.output, /unexpected EOF while looking for matching/);
});

test("an empty command succeeds and prints nothing", () => {
	assert.deepEqual(run(""), { output: "", exitCode: 0 });
});

test("keeps the whole output, so the caller can cap it without losing the tail", () => {
	// Truncating inside the driver makes the command's own `sh` report
	// "Terminated" into the output it is truncating; the cap lives in admin-exec.ts.
	assert.equal(run("printf '0123456789'").output, "0123456789");
});

test("the deadline stops the whole tree and says it did", () => {
	const c = call("echo started; exec sleep 30", { timeoutSeconds: 1 });
	const started = Date.now();
	try {
		c.run();
		const took = Date.now() - started;
		assert.equal(c.read("exit").trim(), "143");
		assert.equal(c.read("stopped").trim(), "deadline");
		assert.ok(took < 15_000, `the deadline should not take ${took}ms`);
	} finally {
		c.cleanup();
	}
});

test("the deadline stops grandchildren too", () => {
	const c = call("sh -c 'sleep 30' & echo \"child $!\"; exec sleep 30", { timeoutSeconds: 1 });
	let childPid;
	try {
		c.run();
		childPid = Number(c.read("out").match(/child (\d+)/)[1]);
		assert.equal(alive(childPid), false, `pid ${childPid} survived the deadline`);
	} finally {
		killQuietly(childPid);
		c.cleanup();
	}
});

test("stops itself when its parent disappears", async () => {
	// Pi's abort SIGTERMs osascript, which orphans the root script. Without the
	// PPID poll that script — and whatever it started as root — runs to the end.
	const c = call("exec sleep 30", { timeoutSeconds: 300 });
	const wrapper = spawn("/bin/sh", ["-c", `sh '${join(c.dir, "driver.sh")}' & wait`], {
		stdio: "ignore",
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 500));
		wrapper.kill("SIGKILL");
		const started = Date.now();
		while (!existsSync(join(c.dir, "exit")) && Date.now() - started < 10_000) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(c.read("stopped").trim(), "parent");
		assert.equal(c.read("exit").trim(), "143");
	} finally {
		killQuietly(wrapper.pid);
		c.cleanup();
	}
});

test("the script path survives being embedded in AppleScript", () => {
	// Reproduce what AppleScript hands the shell, then actually run it, for a
	// path containing a quote and a backslash.
	const base = mkdtempSync(join(tmpdir(), "pi-admin-path-"));
	try {
		const dir = join(base, "it's \\ odd");
		const script = join(dir, "run.sh");
		const literal = macosElevationScript(script).match(/do shell script "(.*)" with admin/)[1];
		const command = literal.replace(/\\(["\\])/g, "$1"); // AppleScript un-escaping
		execFileSync("/bin/sh", ["-c", `mkdir -p '${dir.replace(/'/g, "'\\''")}'`]);
		writeFileSync(script, "echo path-ok\n", { mode: 0o700 });
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
