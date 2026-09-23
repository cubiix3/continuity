# Background runtime (unreleased)

The optional runtime keeps the existing local Dashboard available and synchronizes
registered projects and workspaces. It does not register projects, approve memories,
create handoffs, or change retrieval policy. CLI commands still work without it.

## Windows setup

Use an installed package in a stable location with Node 24.13 or newer:

```powershell
continuity startup install
continuity runtime start
continuity startup status
continuity runtime status
```

Installation schedules startup at the next sign-in. `runtime start` starts it now.
Open `http://127.0.0.1:4783` yourself; login never opens a browser. No administrator
rights are requested. The task runs only in the installing user's logged-in session.
No Windows service, password, execution-policy bypass, or elevated task is installed.

```powershell
continuity runtime stop
continuity startup remove
```

Stopping does not uninstall startup; removing startup does not stop an existing
runtime. Neither command removes projects or stored data. Install is idempotent.
After moving/upgrading Node or the package, run `startup install` again to update
the absolute executable and CLI paths. Status reports missing paths and the stored
command; `current_command` compares it with the options on the current invocation.

`--home` (before the subcommand), then `CONTINUITY_HOME`, then the usual
`~/.continuity` default determine the home. Startup stores the resolved home,
executable, CLI, port and auto-sync option explicitly; login does not guess them
from the environment or current directory.

```powershell
continuity --home "D:\Local state" startup install --port 4784
continuity --home "D:\Local state" runtime start --port 4784
```

Each home can own one runtime. Different homes need different dashboard ports.
An occupied port produces an error rather than selecting a LAN address. A separate
manually started `continuity dashboard` is not silently replaced or stopped.

`runtime run` is the foreground troubleshooting command. `runtime start` detaches
the process and returns. `--no-auto-sync` on install/start/run disables automatic
sync while keeping the Dashboard available. Restart to change runtime options.
Windows and Linux support runtime control; startup installation is Windows-only.

## Automatic sync

- Startup checks registered primary roots and workspaces, with one sync at a time.
- Directory watches come from the existing source scanner: ignores, selection,
  nested project boundaries and symlink exclusion stay authoritative.
- Saves debounce for 1.5 seconds. Changes during sync schedule another pass;
  a queue prevents parallel automatic syncs and rotates scopes fairly.
- Registration changes are checked every 30 seconds. New/rebound roots get a new
  watch plan without restarting the runtime.
- A 10-minute reconciliation catches missing filesystem events and retries errors.
- More than 512 eligible directories in a scope uses periodic reconciliation
  instead of an unbounded watcher set. Failed watches also retain periodic retry.
- Local source scope (`continuity sources set`, see [source-scope.md](source-scope.md))
  narrows the watch plan and every scan identically. Discovery applies a changed or
  cleared filter without restart. Invalid `sources.json` fails scans closed; scopes
  report `degraded` and recover once the file is corrected.
- Source limits remain 2,000 files / 8 MiB and 20,000 traversed entries. Large
  projects need a local source scope or a narrower root.
  Automatic sync does not raise limits or silently claim those projects are fresh.

The synchronous scanner runs in one worker thread so it does not block Dashboard
requests or runtime status. It uses `openContinuity()` and the same SQLite database
and Core. CLI, Dashboard and automatic sync use an OS-owned per-scope lease; concurrent
calls share the completed sync result. Semantic adapters retain their existing
timeouts/fallback behavior. There is no additional semantic pipeline.

Status reports PID, home, URL, worker health, scope results, watcher count, successful
sync time and the next reconciliation. Errors in one scope do not stop others.
Unexpected worker failure is visible; restarting the runtime retries it. This is
not a process supervisor. The next login/start recovers after a process crash.

## Safety and operations

The same Dashboard server binds only `127.0.0.1`, preserving its capability,
same-origin and CSP protections. Local runtime control uses an authenticated IPC
endpoint; a PID file is never used to authorize termination. Ownership disappears
with the process. Sync requests and replies authenticate using a home-local key and
per-request nonce; another local endpoint cannot supply an unsigned sync result.
`runtime.key` and `sync.key` are local secret state and are excluded by the existing
source policy. Do not expose the home to untrusted OS users; local storage is not encrypted.

Logs are `logs/runtime.log` plus one rotated file, approximately 256 KiB each.
They contain event names, timestamps and opaque scope IDs, not source bodies or
raw exceptions. Log failures never reset stored data.

Stop waits for the active sync and closes watches, servers and storage. If a bounded
stop wait expires, the command reports it without force-killing anything. Windows
logoff may terminate processes without delivering a graceful signal; SQLite crash
recovery still applies. No reset or re-registration is performed.

## Validation

`pnpm check`, `pnpm test:ui`, `pnpm test:pack`, and `pnpm test:runtime-pack` cover the
Core, runtime queue, isolation, startup adapter and installed package. The Windows
package smoke installs a temporary user task, launches its exact registered command,
verifies automatic source-hash changes and browser operation, then removes the task.
Linux runs the portable runtime smoke and checks that startup installation is unsupported.

This launch simulation is not a real login test. Before recommending unattended
daily use, sign out/in once with a stable installed package: open the Dashboard
without a terminal, verify registered projects, change a fixture source and confirm
its new hash without manual sync. Do not reboot an active development session as
part of the automated suite.
