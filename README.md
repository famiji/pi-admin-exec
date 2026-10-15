# pi-admin-exec

[![test](https://github.com/famiji/pi-admin-exec/actions/workflows/test.yml/badge.svg)](https://github.com/famiji/pi-admin-exec/actions/workflows/test.yml)

**Run privileged commands from any Pi session, including the non-interactive ones.**

Pi's existing sudo extensions need an interactive terminal, because that is where
their masked password prompt is drawn. Under `pi --mode json` or `pi --mode rpc`
— which is how pi-web and other front-ends drive Pi — there is no terminal.
`ctx.ui.custom()` returns `undefined` in RPC mode, and the RPC `input` dialog has
no mask field, so an extension cannot draw a masked prompt there either. Those
extensions refuse the session by design.

`pi-admin-exec` avoids the problem instead of solving it: it never asks Pi for a
password field. It hands the command to the operating system's own authorization
dialog, which is already masked, already trusted, and available in every session
type.

## How it works

1. `admin_exec` shows the exact command and your stated reason in a normal Pi
   confirmation dialog (`ctx.ui.confirm`, which works in the TUI *and* in
   RPC/pi-web).
2. Declining runs nothing, and no credential prompt appears.
3. On approval the command is written to a private temporary directory
   (`mkdtemp`, mode `0700`).
4. macOS asks for administrator credentials in its own SecurityAgent window.
5. The command's merged stdout/stderr and its exit code come back as the tool
   result, and the attempt is appended to the audit log.

The password is typed into the system dialog. It never passes through Pi, this
extension, `argv`, the environment, or the model's context. That is a stronger
guarantee than forwarding a credential through an extension's stdin, because
there is no credential for the extension to hold.

## Install

```bash
pi install npm:pi-admin-exec
```

Requires Pi and Node.js ≥ 22.19.0. macOS only, for now.

`/reload` picks the extension up in a running session.

## Usage

```jsonc
{
  "command": "launchctl bootout system /Library/LaunchDaemons/com.example.agent.plist", // runs as root
  "reason": "unload a stale privileged agent",                                           // shown before anything runs
  "timeoutMs": 900000                                                                    // optional
}
```

- The command runs under `/bin/sh`. **Put every privileged step in this one
  command** (`&&`, `;`, a here-doc, a small inline script). The user
  authenticates once per call, and every call is a separate prompt.
- `reason` is required. It is the point of the confirmation step: the model has
  to state why root is needed, in front of the user, before anything happens.
- `timeoutMs` defaults to 15 minutes. The temporary script is removed when the
  call finishes.

### Audit trail

Every call appends one JSON line to `~/.pi/agent/admin-exec.log` (mode `0600`) —
what ran, why, and how it ended:

```json
{"ts":"2026-10-16T09:12:04.881Z","command":"id -u","reason":"check the uid","outcome":"ran","exitCode":0,"durationMs":1180}
```

`outcome` is `ran`, `declined`, `cancelled`, or `error`. **Declined and cancelled
attempts are recorded too** — knowing what was *tried* is the point of a log
like this, not only what succeeded.

```
/admin       last 10 entries
/admin 50    last 50 entries
```

A logging failure never fails the command; it goes to stderr and the command
still runs.

## Security model

### What it does guarantee

- **The command is shown before it runs.** In the TUI and in RPC/pi-web the
  confirmation dialog comes first, with the full command text. A declined
  confirmation means nothing runs.
- **No credential is ever handled in userspace.** There is nothing to leak into
  `argv`, the environment, logs, or the model's context.
- **Privileged work happens in a private temporary directory**, created with
  `mkdtemp` and mode `0700`, and is deleted in a `finally` block.
- **The exit code survives a failing command.** The wrapper runs your command in
  a subshell, captures `$?`, and reports it as data, so a non-zero exit is a
  normal tool result rather than a lost error.

### What it does not guarantee

- **The macOS dialog does not display the command text.** The system window only
  says that an application wants to make changes. The Pi confirmation dialog is
  the only place the command appears, so **in a non-interactive run (`pi -p`)
  there is no confirmation dialog at all** — the command is written to stderr
  instead, and the password prompt is the only gate. Prefer running this tool
  from an interactive session.
- **Anything the command prints lands in the model's context.** This tool does
  not scrub output, because it never holds a secret to scrub. If a privileged
  command prints a credential, the model sees that credential.
- **This is not a sandbox and not a privilege boundary.** The user authorizes, at
  the operating-system level, a shell as root. A command that is wrong is wrong
  with root.
- **The wrapped command inherits the invoking user's environment.** Root `PATH`
  quirks are the command's problem, not the tool's.

## Comparison with other Pi sudo packages

| | works in pi-web / RPC | credential prompt | refuses headless |
|---|---|---|---|
| **pi-admin-exec** | yes | OS dialog | no |
| `@pi-archimedes/sudo` | no | masked prompt in the TUI | yes |
| `pi-private-input` | no | masked prompt in the TUI | yes |
| `@xynogen/pix-sudo` | no | PAM prompt | yes |
| `@tinoy/pi-sudo-approve` | no | desktop prompt window or TUI | — |

*(Summarised from those packages' documentation; check their source before relying on it.)*

If you work in the TUI and want a credential cache with a TTL and output
scrubbing, `@pi-archimedes/sudo` is a good fit. If you need privileged commands
from pi-web or from a headless run, that design cannot work — which is the gap
this package fills.

## Platform support

| Platform | Mechanism | Status |
|---|---|---|
| macOS | `osascript … with administrator privileges` | implemented |
| Linux | `pkexec` (polkit agent) | not implemented |
| Windows | UAC, via `Start-Process -Verb RunAs` or `sudo.exe` | not implemented |

Two things worth knowing before porting:

- The platform-independent half — `buildWrapper` and `parseResult` in
  `src/elevate.mjs` — is reused as-is. A backend only supplies the elevation
  command and the cancel detection.
- **Do not pretend the platforms are equivalent.** On macOS, and on Linux with
  polkit, the user types a password. **Windows UAC is a consent dialog**: an
  administrator clicks *Yes* without typing anything. Microsoft's own `sudo.exe`
  documents this — *"sudo can only be elevated via the User Account Control
  (UAC) … verification prompt"* — so a Windows port would have a strictly weaker
  gate. Windows elevation also does not return the child's stdout or exit code,
  which needs a temp-file handshake on top of `-Wait`.

## Development

```bash
npm test   # node --test — no root, no dialogs
```

The suite runs the wrapper under plain `/bin/sh`, so it covers exit-code
reporting, stderr merging, marker stripping, and AppleScript path escaping
without needing administrator credentials.

```
extensions/admin-exec.ts   the tool: confirm, elevate, parse, report; the /admin command
src/elevate.mjs            wrapper + macOS backend (the porting seam) + audit formatting
test/admin-exec.test.mjs
```

## License

MIT
