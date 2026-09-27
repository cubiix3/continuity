# 018: Sign-in startup without a console window

Amends [ADR 008](008-background-runtime.md) (issue #44).

## Context

The sign-in task started `node.exe <cli> --home <home> runtime start --port <port>` directly. Node is a console
program, and Task Scheduler starts it without a console. So Windows opened one at every sign-in: a Windows Terminal
window when that is the default terminal. It stays open while `runtime start` launches the hidden runtime.

Measured with EnumWindows on Windows 11 build 26200, running the installed task on demand:
- runtime already running: one Windows Terminal window;
- runtime stopped: a Windows Terminal window, and a pseudo-console window owned by `node`.

In both cases Task Scheduler started the process, and the task result was 0.

## Decision

- **The action is Microsoft's console host, started headless.** The executable is `conhost.exe` in the Windows system
  directory. The arguments are `--headless` followed by exactly the previous command, each part quoted with Windows
  argv rules: `"<node.exe>" "<cli>" "--home" "<home>" "runtime" "start" "--port" "<port>"`. The headless console host
  (the one ConPTY uses) gives Node a console without a window.
- **Nothing else changes.** The task keeps its security context: the current user's interactive token, the Limited
  run level, no stored password, no elevation. Its single-instance setting is unchanged. There is no shell, script
  host or launcher of Continuity's own. `runtime start` still launches the same detached, hidden runtime, then exits,
  and so does the console host.
- **The one-minute limit.** Task Scheduler's limit now ends only the console host, not the Node process it started.
  So `runtime start` ends itself after 45 seconds at most, recording `start_timeout`. Its own wait for the runtime is
  about 10 seconds.
- **The exact-command check covers the whole action.** `startup status` reports `current_command: true` only when all
  of these hold:
  - the task has exactly one action;
  - that action is this `conhost.exe`, with no working directory;
  - its arguments are exactly the expected string (Node, CLI, home and port included).

  The arguments are compared ordinally, character by character. PowerShell's `-ceq` compares by culture and treats a
  soft hyphen, a zero-width joiner or a decomposed `ü` as equal, which would let an altered task that runs another
  file still read as current.

  An older direct task, a missing `--headless`, another Node, CLI, home, port or console host, an extra argument, an
  invisible or decomposed character, a working directory or a second action all read as not current.
  `startup install` replaces the task in place. When registering, the adapter checks that the console host is the
  Windows system copy (`GetSystemDirectory`), so an altered `SystemRoot` cannot point the task elsewhere. `launcher`
  names a wrapped task on any other console host as not the system copy.
- **Refused setups.** `startup install` installs nothing, and says why, in two cases:
  - **The legacy console is on.** With "Use legacy console" (`HKCU\Console\ForceV2 = 0`), the console host ignores
    `--headless` in favour of the legacy console. Started by Task Scheduler it then fails (`0x80070057`) without
    starting Node, so the runtime would silently never start. `startup status` reports that setting as
    `supported: false` too.
  - **A path contains `%`.** Task Scheduler expands `%VAR%` in the command line, and so does the console host. A Node,
    CLI or home path containing `%` would start something else while still reading as current, so it is refused.
- **Continuity records each start itself.** The console host's exit code is always 0, so Task Scheduler's result no
  longer shows whether the runtime started. `runtime start` therefore replaces `runtime-start.json` in the home,
  atomically, with a small record:
  - a timestamp;
  - the outcome (`started`, `already_running` or `failed`) and its exit code;
  - for a failure, a fixed category: `invalid_arguments`, `spawn_failed`, `runtime_exited`, `start_timeout` or
    `error`.

  It never holds messages, paths or output.
- **`startup status` combines the two.**
  - `startup_result` is the record of the task's last run. A record counts only when it was written at or after
    that run's start (Task Scheduler keeps whole seconds) and within the task's one-minute limit.
  - Task Scheduler keeps the last run time when a task is replaced. A run from before the current registration, which
    the task records as its registration date, is not counted: after a reinstall, the result reads `not_run` until
    the next run.
  - An older record, from a previous run or a manual start, is never shown as the current result. A run without its
    own record reads `no_result`: for example, a missing CLI, where Node exits before Continuity runs.
  - The console host's exit code is reported separately as `task.launcher_result`, and is not treated as the start's
    outcome.
- **Windows version.** `conhost.exe --headless` exists from Windows 10 version 1809 (build 17763).
  - On older builds, `startup install` refuses with a clear message and installs nothing. `startup status` reports
    `supported: false`.
  - There is no silent fallback to a task that opens a window.
  - Verified on Windows 11 build 26200 only.

## Alternatives

- **`conhost.exe --headless`:** chosen. On demand from Task Scheduler with the same principal, it opened no window:
  on success, on a non-zero exit, with a 5 s start, with a detached child, and with a path containing spaces and `ü`.
  The headless host exited with its child.
  - It does not pass the child's exit code on: exit codes 3 and 1 both became 0. The start record replaces that
    information.
  - It re-quotes the command line it passes on. The independent review sent 28 home values through it intact,
    including `&`, `^`, parentheses, `!`, quotes, tabs and trailing backslashes. `%VAR%` is the exception, refused
    above.
- **A Continuity launcher built as a Windows GUI program:** rejected. It showed no window and kept exit codes, but it
  adds an unsigned executable, compiled on the user's machine or shipped prebuilt. A new executable that starts
  hidden processes at logon is also what antivirus heuristics look for.
- **PowerShell `-WindowStyle Hidden`, `cmd /c start /b`, script hosts (`wscript`, VBScript, JScript):** rejected.
  They are console programs that still open a window first, or script hosts, and they add a shell to the action.
- **An S4U or "run whether signed in or not" task:** rejected. It would hide the window by changing the security
  context: no interactive token, and no user profile network access.
- **Task Scheduler's "hidden" setting:** it hides the task in the Task Scheduler UI, not the window.

## Consequences

- **No window.** Nothing appears at sign-in, or on any on-demand run, whether the runtime was stopped, already
  running, or failed to start (EnumWindows: 0 windows in all three cases).
- **Upgrade.** Existing installs report `launcher: direct …` and `current_command: false` until
  `continuity startup install` runs again.
- **Diagnosis.** `continuity startup status` reads `startup_result`; Task Scheduler's own "Last Run Result" no longer
  shows start failures.
- **Manual starts share the record.** A manual `runtime start` within a minute of a task run counts as that run's
  result.
