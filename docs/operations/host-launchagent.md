# Loopback HAB host under a user LaunchAgent

This is an opt-in operator runbook for the [configured service](../host-service.md).
The application does not install a job itself. Starting a listener, saving stable
store keys and granting individual access have separate approval boundaries.
A supervised all-deny host start is infrastructure evidence; it does not establish
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

## Keep the delivery store with the host state

The host delivers through its own `delivery.sqlite` in the state directory and needs
no broker job. Keep the state directory on the persistent volume named by
`delivery.volume`, and back it up as one generation with the recipients' state
([delivery store](../delivery-store.md#back-up-and-restore)). When replacing a JetStream
build, unload its broker job only after draining and removing the old journal
([upgrade procedure](../delivery-store.md#upgrade-from-the-jetstream-build)).

## Install a new user job explicitly

Check that neither the selected label nor its plist belongs to an existing job.
Create a new 0600 file in the current user's `~/Library/LaunchAgents/` without
overwriting other jobs. The following is a template, not a ready-to-load config:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.hab.host</string>
  <key>ProgramArguments</key><array>
    <string>/ABSOLUTE/NODE</string>
    <string>/ABSOLUTE/RELEASE/hab-host.mjs</string>
    <string>--config</string>
    <string>/ABSOLUTE/PRIVATE/service.local.json</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/RELEASE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
```

This user-session job starts when loaded/login occurs. It is not a system daemon
that promises operation after logout. launchd restarts the host after any exit,
clean or not, with throttling ([ADR-024](../hab-decisions.md)): a host that stops
silently leaves mail unnoticed and lets cloud agents' event subscriptions lapse.
Stop it on purpose only with `launchctl bootout` (below), which unloads the job;
a `kill` or SIGTERM alone is followed by a restart. Lifecycle output goes
to `/dev/null`; the configured bounded private security audit remains enabled.
Check job status and use the foreground CLI for a sanitized startup failure report.
No environment dump or full process arguments are needed in a support message.

Load only the newly reviewed plist:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.hab.host.plist"
```

Confirm this exact job is loaded and owns only the intended IPv4 loopback listener.
Check unauthenticated/unknown credentials return 401 and a foreign Host returns 403.
Use a client that actually sends the selected Host header; clients may normalize it.
These checks do not replace the independent process/code Inspector required before
any real Hermes execution.

Stop and unload only this job:

```sh
launchctl bootout "gui/$(id -u)/local.hab.host"
```

Confirm its owned listener closed. Keep DB/integrity keys for recovery. To restart,
bootstrap the same reviewed plist again and verify the same state/config/release.
If installation/start is refused, report that refusal; do not install an alternate
scheduler or launch route. Remove a newly prepared unloaded plist when abandoning
installation so it cannot unexpectedly start at a later login.

`launchctl kickstart -k "gui/$(id -u)/local.hab.host"` restarts it in place.

## Keep the Mac awake in a separate job

Do not wrap the host in `caffeinate`: when the host stops, the wrapper goes with it
and the Mac falls asleep, so cloud agents cannot reach the ingress and their event
subscriptions cannot be refreshed (2026-11-17). Keep the machine awake with its own
job that does not depend on the host. It needs no `sudo`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.hab.awake</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>-s</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
```

`-i` prevents idle sleep and `-s` system sleep while on AC power; the display may
still sleep. Check with `pmset -g assertions | grep caffeinate`. The equivalent
system setting is `sudo pmset -a sleep 0`; `sudo pmset -a autorestart 1` also starts
the Mac again after a power failure. Both are owner decisions.
