# Changelog

## 0.2.1 — 2026-10-28

Fixes for the failure modes found while auditing timeouts and error reporting.

- **A timeout now stops the command, not just the dialog.** The old wrapper was
  killed together with `osascript`, which left the root command — and anything it
  had started — running. A driver script now owns the deadline, kills the whole
  process tree, and records that it did, so a timeout is reported as a timeout.
- **An abandoned call stops itself.** If Pi aborts the call or exits, the driver
  notices its parent is gone and stops the command instead of running on as root
  until the deadline.
- **The exit status travels out of band.** It is written to a file rather than
  printed, so a command that prints the marker can no longer forge its own status
  and a truncated output cannot lose it.
- **The command is written verbatim.** It is no longer interpolated into a shell
  string, so quoting and here-docs reach the shell unchanged, and a syntax error
  is reported as the shell's own failure instead of as "osascript refused the
  request".
- **Output is capped by the caller** at 200 000 bytes, and the result says when it
  was truncated.
- The README installs from GitHub; the package is not published to npm.

## 0.2.0 — 2026-10-16

- `admin_exec` now writes an audit trail to `~/.pi/agent/admin-exec.log`
  (JSON Lines, mode `0600`): command, reason, outcome, exit code, duration.
  Declined and cancelled attempts are recorded too.
- New `/admin` command renders the most recent entries, `/admin 50` for more.
- The command now leads the tool result, so a transcript says what ran and not
  only what it printed.

## 0.1.0 — 2026-10-16

Initial release.

- `admin_exec`: run one shell command as root from any Pi session, including
  RPC (pi-web) and headless runs, by delegating authentication to the operating
  system's authorization dialog.
- The exact command and the model's reason are confirmed with the user before
  anything runs.
- Merged stdout/stderr and the real exit code come back as data. The command
  runs in a subshell, so a bare `exit` cannot skip exit-code reporting.
- No credential is ever handled in userspace.
- macOS only. Linux and Windows backends are not implemented; see the README
  for what porting them would actually mean.
