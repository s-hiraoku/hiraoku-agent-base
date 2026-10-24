# Loopback Relay under a user LaunchAgent

This is an opt-in operator runbook for the [configured service](local-relay-service.md).
The application does not install a job itself. Starting a listener, saving stable
store keys and granting individual access have separate approval boundaries.
A supervised all-deny Relay start is infrastructure evidence; it does not establish
Dots/Hermes identity, model isolation, billing or a real agent roundtrip.

## Prepare a dedicated release

Use a tested, merged commit with successful CI. Build/copy a dedicated release
outside the mutable working checkout, record its commit and artifact SHA-256, and
verify the artifact before starting. Supply an absolute Node executable and
absolute private config path; no secret belongs in arguments or the plist.
Verify a bundled artifact with finite start → 401/403 checks → SIGTERM stop before
installing it. The release directory may be read-only; state/config/audit paths
are separate and absolute. Do not embed live configuration in the artifact.

Prepare owner-only config/state/audit directories and 0600 private config files.
An explicitly empty `{ "version": 1, "credentials": [] }` mapping keeps the
service all-deny. Missing config, invalid keys or permissive files refuse startup.
Never substitute fixture credentials. Stop on a port collision; do not terminate
an existing listener. Review finite capacity and maintenance policy before enabling
unattended message acceptance. This runbook starts no Adapter cycle, model or API.

## Install a new user job explicitly

Check that neither the selected label nor its plist belongs to an existing job.
Create a new 0600 file in the current user's `~/Library/LaunchAgents/` without
overwriting other jobs. The following is a template, not a ready-to-load config:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.hab.relay</string>
  <key>ProgramArguments</key><array>
    <string>/ABSOLUTE/NODE</string>
    <string>/ABSOLUTE/RELEASE/hab-relay.mjs</string>
    <string>--config</string>
    <string>/ABSOLUTE/PRIVATE/service.local.json</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/RELEASE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
```

This user-session job starts when loaded/login occurs. It is not a system daemon
that promises operation after logout. Failed exits may restart with throttling;
a clean CLI shutdown does not request an automatic restart. Lifecycle output goes
to `/dev/null`; the configured bounded private security audit remains enabled.
Check job status and use the foreground CLI for a sanitized startup failure report.
No environment dump or full process arguments are needed in a support message.

Load only the newly reviewed plist:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.hab.relay.plist"
```

Confirm this exact job is loaded and owns only the intended IPv4 loopback listener.
Check unauthenticated/unknown credentials return 401 and a foreign Host returns 403.
Use a client that actually sends the selected Host header; clients may normalize it.
These checks do not replace the independent process/code Inspector required before
any real Hermes execution.

Stop and unload only this job:

```sh
launchctl bootout "gui/$(id -u)/local.hab.relay"
```

Confirm its owned listener closed. Keep DB/integrity keys for recovery. To restart,
bootstrap the same reviewed plist again and verify the same state/config/release.
If installation/start is refused, report that refusal; do not install an alternate
scheduler or launch route. Remove a newly prepared unloaded plist when abandoning
installation so it cannot unexpectedly start at a later login.
