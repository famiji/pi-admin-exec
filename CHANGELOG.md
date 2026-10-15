# Changelog

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
