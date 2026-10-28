/**
 * pi-admin-exec — run privileged commands from any Pi session, including the
 * non-interactive ones (RPC / pi-web / headless) that TTY-based sudo extensions
 * refuse.
 *
 * Elevation is delegated to the operating system's own authorization dialog, so
 * no password field has to be drawn by Pi and no credential ever passes through
 * this process, its argv, its environment, or the model's context.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	auditRecord,
	buildDriver,
	formatAuditEntry,
	isUserCancel,
	macosElevationScript,
	parseAuditLog,
} from "../src/elevate.mjs";

const OSASCRIPT = "/usr/bin/osascript";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Extra time the parent allows the driver over its own deadline. */
const PARENT_GRACE_MS = 10_000;
const MAX_OUTPUT_BYTES = 200_000;
const AUDIT_LOG = join(homedir(), ".pi", "agent", "admin-exec.log");
const AUDIT_TAIL = 10;

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "admin_exec",
			label: "Admin Exec",
			description:
				"Run one shell command as root. The user approves the command in a confirmation " +
				"dialog, then authenticates in the operating system's own dialog — never share a " +
				"password with this tool, it is typed into the system window. Put every privileged " +
				"step in a single command (`&&`, `;`, or a here-doc) so the user authenticates once. " +
				"Returns the command's merged stdout/stderr and its exit code. macOS only.",

			parameters: Type.Object({
				command: Type.String({
					description:
						"Shell command to run as root. Runs under /bin/sh together with every other " +
						"privileged step you need.",
				}),
				reason: Type.String({
					description:
						"One sentence, shown to the user, explaining why root is needed and what the " +
						"command changes.",
				}),
				timeoutMs: Type.Optional(
					Type.Number({
						description: `Abort after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
					}),
				),
			}),

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { command, reason } = params;

				if (!(await confirm(ctx, command, reason))) {
					record(command, reason, "declined");
					return {
						content: [{ type: "text", text: "User declined; nothing ran." }],
						details: { declined: true, command },
					};
				}

				const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
				const startedAt = Date.now();
				const dir = mkdtempSync(join(tmpdir(), "pi-admin-"));
				const driverPath = join(dir, "driver.sh");
				const exitPath = join(dir, "exit");
				const outPath = join(dir, "out");
				const stoppedPath = join(dir, "stopped");
				try {
					// The command is written verbatim: shell-level syntax it rejects is
					// reported as its own failure, not as the dialog refusing to open.
					writeFileSync(join(dir, "cmd.sh"), `${command}\n`, { mode: 0o600 });
					writeFileSync(
						driverPath,
						buildDriver(dir, { timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)) }),
						{ mode: 0o700 },
					);

					let result;
					try {
						result = await pi.exec(OSASCRIPT, ["-e", macosElevationScript(driverPath)], {
							timeout: timeoutMs + PARENT_GRACE_MS,
							signal,
						});
					} catch (error) {
						record(command, reason, "error", { durationMs: Date.now() - startedAt });
						return toolError(`Could not start ${OSASCRIPT}: ${describe(error)}`, command);
					}

					const durationMs = Date.now() - startedAt;

					if (isUserCancel(result.stderr)) {
						record(command, reason, "cancelled", { durationMs });
						return {
							content: [{ type: "text", text: "Authentication was cancelled." }],
							details: { cancelled: true, command },
						};
					}

					if (!existsSync(exitPath)) {
						record(command, reason, "error", { durationMs });
						return toolError(
							[
								result.killed
									? "The command was interrupted before it finished, so its exit status is unknown."
									: "The command finished without recording an exit status.",
								result.stderr.trim(),
							]
								.filter(Boolean)
								.join("\n"),
							command,
							result.stderr,
						);
					}

					const exitCode = Number.parseInt(readFileSync(exitPath, "utf8").trim(), 10);
					const full = readFileSync(outPath, "utf8");
					const truncated = Buffer.byteLength(full) > MAX_OUTPUT_BYTES;
					// Capped here rather than in the driver: a child `head` closing the pipe
					// makes sh report "Terminated" into the output it was truncating.
					const output = (truncated ? full.slice(0, MAX_OUTPUT_BYTES) : full).replace(/\n+$/, "");
					const stopped = existsSync(stoppedPath) ? readFileSync(stoppedPath, "utf8").trim() : "";

					// The command leads the result so the transcript says what ran, not just what it printed.
					const text = [
						`$ ${command}`,
						output || "(no output)",
						truncated ? `(output truncated at ${MAX_OUTPUT_BYTES} bytes)` : "",
						`exit code: ${Number.isNaN(exitCode) ? "unknown" : exitCode}`,
						stopped === "deadline" ? `stopped after ${timeoutMs}ms by the deadline` : "",
						stopped === "parent" ? "stopped: the session that started it went away" : "",
						!stopped && result.killed ? "interrupted before the command finished" : "",
					]
						.filter(Boolean)
						.join("\n");

					record(command, reason, "ran", { exitCode, durationMs });

					return {
						content: [{ type: "text", text }],
						details: {
							command,
							exitCode,
							output,
							truncated,
							stopped,
							stderr: result.stderr,
							durationMs,
						},
						...(exitCode !== 0 ? { isError: true } : {}),
					};
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
		}),
	);

	pi.registerCommand("admin", {
		description: "Show the privileged commands admin_exec was asked to run",
		handler: async (args, ctx) => {
			const requested = Number.parseInt((args ?? "").trim(), 10);
			const limit = Number.isInteger(requested) && requested > 0 ? requested : AUDIT_TAIL;
			const text = readAuditLog(limit);
			if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(text, "info");
			else process.stderr.write(`${text}\n`);
			return {};
		},
	});
}

/**
 * Ask before elevating. The TUI and RPC (pi-web) sessions get a real dialog.
 * A piped, non-interactive run has no dialog, so the command goes to stderr
 * instead — the system password prompt is still the gate, but the command
 * should never be invisible to whoever is watching the terminal.
 */
async function confirm(ctx, command, reason) {
	if (typeof ctx?.ui?.confirm === "function") {
		return await ctx.ui.confirm(`Run as root?\n\n${command}`, reason);
	}
	process.stderr.write(`[pi-admin-exec] running as root: ${command}\n`);
	return true;
}

/** Append one audit line. A logging failure must never fail the command. */
function record(command, reason, outcome, extra) {
	try {
		appendFileSync(AUDIT_LOG, `${JSON.stringify(auditRecord(command, reason, outcome, extra))}\n`, {
			mode: 0o600,
		});
	} catch (error) {
		process.stderr.write(`[pi-admin-exec] could not write ${AUDIT_LOG}: ${describe(error)}\n`);
	}
}

function readAuditLog(limit) {
	if (!existsSync(AUDIT_LOG)) return `No privileged commands recorded yet (${AUDIT_LOG}).`;
	const entries = parseAuditLog(readFileSync(AUDIT_LOG, "utf8"), limit);
	if (entries.length === 0) return `No privileged commands recorded yet (${AUDIT_LOG}).`;
	return [
		`Last ${entries.length} privileged command${entries.length === 1 ? "" : "s"} (${AUDIT_LOG}):`,
		"",
		...entries.map(formatAuditEntry),
	].join("\n");
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

function toolError(text, command, stderr) {
	return {
		content: [{ type: "text", text }],
		details: { error: text, command, stderr },
		isError: true,
	};
}
