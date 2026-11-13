# Manual token input for the existing inventory entry

`scripts/inventory_token_input.py` accepts an already acquired worker Bearer via
`getpass` in a real Terminal. It never issues or refreshes a token, enrolls a
subject, submits a task, changes a policy, or starts automatically. It calls the
existing inventory entry, whose signature, issuer, resource, subject/client,
scope, Inspector and one-shot checks still apply.

Both stdin and stderr must be TTYs. A `GetPassWarning` rejects the operation;
getpass's plaintext fallback is forbidden. The entered authorization must match
the entry's Bearer JWT shape and at most 16,384 UTF-8 bytes. Only one JSON object
of at most 17,000 bytes goes to the child stdin, then EOF. This is a size check
after interactive input, not a bounded-memory terminal editor or JWT validation.

The child command contains only the reviewed Node executable and fixed inventory
entry path. Its explicit environment contains only PATH and the approved private
config path. It inherits no ambient token or other secret. stdout/stderr go to
the null device; errors printed by the helper are fixed labels, never child
output, config contents, argv, token input or a traceback. No token is written
to a file. The payload bytearray is cleared on completion/failure; Python and
subprocess string copies cannot be reliably zeroized.

The private config must be an owner-only regular file, not a symlink, and must
select enabled `inventory-one-shot` mode before prompting. The entry remains the
authority for the complete config. After stdin delivery the helper waits up to
130 seconds (the entry's maximum lifetime is 120 seconds), then requests SIGTERM,
waits two seconds, requests SIGKILL if necessary, and waits two more seconds.
Cancellation follows the same owned-child cleanup. Further SIGINTs are ignored
only during the bounded stop escalation, then the prior signal handler is restored;
a second Ctrl-C cannot skip SIGKILL or exit confirmation. Failure to confirm exit is
reported as uncertain. No receipt or runtime artifact is deleted, no task is
resubmitted, and a parent crash cannot guarantee child cleanup. The existing
Python launcher lifetime guard and reconciliation requirements remain necessary.
`inventory_entry_exited` means the entry exited normally, not that a task ran or
succeeded; acceptance still requires authenticated result retrieval and durable
stop/receipt evidence.

## Operator sequence after all live gates pass

1. Review the current code/import/OS boundary, confirm fixed provider entitlement
   and included allowance with additional cost $0, and verify the separately
   approved requester/worker bindings and exact scopes. An EPERM is still blocked;
   do not move execution elsewhere merely to avoid it.
2. Use the existing client's approved authentication flow yourself. No new client,
   persistent key, paid grant, refresh or fallback is implied. Do not send the
   token through chat, shell arguments, exported environment or a repo file.
3. From this checkout in a normal interactive Terminal, invoke the helper with
   the reviewed absolute Node path and approved active private config path:

   ```sh
   python3 -B scripts/inventory_token_input.py \
     --node /approved/path/to/node \
     --config /approved/private/inventory.local.json
   ```

   Enter `Bearer ` followed by the existing worker access token only at the hidden
   prompt. The placeholders are intentional; this is not approval to execute a
   denied operation in another environment. No real credentials are used in tests.
4. The separately authenticated requester submits only the fixed inventory task
   and retrieves its result. Confirm child shutdown and reconciliation state.
   An incomplete result or uncertain stop does not authorize another attempt.

## Remaining isolation design work

The current Inspector asks `access(W_OK)` and accepts only EACCES as evidence of
denied writes. A sandbox returning EPERM prevents that evidence and is not proof
of OS immutability. Mode bits alone also cannot prove absence of ACL grants or
immutable ownership by a hostile same-user process. The guard is unchanged.

A future separately reviewed design could verify an OS-enforced read-only runtime
mount and a dedicated execution identity with no ability to replace the mount or
its parent paths, while binding the complete import/native closure, hashes and
process identity. Such provenance would need its own attestation contract and
tests, not an EPERM exception or weaker probe. It would require explicit approval
for the OS isolation changes; this helper installs or configures none of them.

## Dummy validation

`python3 -B -m unittest scripts.test_inventory_token_input` exercises actual
getpass in a PTY, real harmless child stdin/output suppression, input bounds,
non-TTY/echo fallback rejection, config gates, cancellation, timeout and uncertain
stop. It does not contact Auth0, bind a service, start Hermes or run a model.
