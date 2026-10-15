/**
 * pi-admin-exec — run privileged commands from any Pi session, including the
 * non-interactive ones (RPC / pi-web / headless) that TTY-based sudo extensions
 * refuse.
 *
 * Elevation is delegated to the operating system's own authorization dialog, so
 * no password field has to be drawn by Pi and no credential ever passes through
 * this process, its argv, its environment, or the model's context.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildWrapper,
	isUserCancel,
	macosElevationScript,
	parseResult,
} from "../src/elevate.mjs";

const OSASTATEMENT = "/usr/bin/osascript";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

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
				if (!(await confirm(pi, ctx, params.command, params.reason))) {
					return {
						content: [{ type: "text", text: "User declined; nothing ran." }],
						details: { declined: true },
					};
				}

				const dir = mkdtempSync(join(tmpdir(), "pi-admin-"));
				const scriptPath = join(dir, "run.sh");
				try {
					writeFileSync(scriptPath, buildWrapper(params.command), { mode: 0o700 });

					let result;
					try {
						result = await pi.exec(OSASTATEMENT, ["-e", macosElevationScript(scriptPath)], {
							timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
							signal,
						});
					} catch (error) {
						return toolError(`Could not start ${OSASTATEMENT}: ${describe(error)}`);
					}

					if (isUserCancel(result.stderr)) {
						return {
							content: [{ type: "text", text: "Authentication was cancelled." }],
							details: { cancelled: true },
						};
					}

					const { output, exitCode } = parseResult(result.stdout ?? "");
					if (exitCode === null && result.stderr) {
						return toolError(
							`osascript refused the request: ${result.stderr.trim()}`,
							result.stderr,
						);
					}

					const text = [
						output || "(no output)",
						`exit code: ${exitCode ?? "unknown"}`,
						result.killed ? "killed: timed out or aborted" : "",
					]
						.filter(Boolean)
						.join("\n");

					return {
						content: [{ type: "text", text }],
						details: { exitCode, output, stderr: result.stderr, killed: result.killed },
						...(exitCode !== 0 ? { isError: true } : {}),
					};
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
		}),
	);
}

/**
 * Ask before elevating. The TUI and RPC (pi-web) sessions get a real dialog.
 * A piped, non-interactive run has no dialog, so the command goes to stderr
 * instead — the system password prompt is still the gate, but the command
 * should never be invisible to whoever is watching the terminal.
 */
async function confirm(pi, ctx, command, reason) {
	if (typeof ctx?.ui?.confirm === "function") {
		return await ctx.ui.confirm(`Run as root?\n\n${command}`, reason);
	}
	process.stderr.write(`[pi-admin-exec] running as root: ${command}\n`);
	return true;
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

function toolError(text, stderr) {
	return {
		content: [{ type: "text", text }],
		details: { error: text, stderr },
		isError: true,
	};
}
