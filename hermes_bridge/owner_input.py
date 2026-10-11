"""Manual hidden input of an ALREADY acquired short worker token.

No OAuth acquisition, secret lookup, enrollment or daemon. Verification returns a
candidate identity only. Inventory mode requires separate execution approval.
Python strings are not guaranteed to be erased; no token is saved or printed.
"""

import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import warnings


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("--verify-worker", "--run-inventory"):
        raise ValueError()
    action, raw_path, raw_node = sys.argv[1:]
    path = Path(raw_path).absolute()
    before = path.lstat()
    if (
        path.resolve() != path
        or not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.getuid()
        or before.st_mode & 0o077
        or before.st_size > 65536
        or not path.name.endswith(".local.json")
    ):
        raise ValueError()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as file:
        opened = os.fstat(file.fileno())
        settings = json.loads(file.read(65537))
    after = path.lstat()
    if any(
        (s.st_dev, s.st_ino, s.st_ctime_ns, s.st_size)
        != (before.st_dev, before.st_ino, before.st_ctime_ns, before.st_size)
        for s in (opened, after)
    ):
        raise ValueError()
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise ValueError()
    node = Path(raw_node).absolute()
    node_stat = node.lstat()
    if (
        node.resolve() != node
        or not stat.S_ISREG(node_stat.st_mode)
        or node_stat.st_uid not in (0, os.getuid())
        or node_stat.st_mode & 0o022
        or not os.access(node, os.X_OK)
    ):
        raise ValueError()
    root = Path(__file__).resolve().parent.parent
    env = {"PATH": os.environ.get("PATH", "")}
    if action == "--verify-worker":
        if settings.get("mode") != "verify-worker-identity":
            raise ValueError()
        entry = root / "src/worker-identity-cli.ts"
        env["HAB_WORKER_IDENTITY_CONFIG"] = str(path)
        checked = subprocess.run(
            [str(node), str(entry), "--check-config"],
            cwd=root,
            env=env,
            capture_output=True,
            check=False,
        )
        if checked.returncode != 0:
            raise ValueError()
    else:
        if (
            settings.get("mode") != "inventory-one-shot"
            or settings.get("enabled") is not True
            or any(
                not isinstance(settings.get(k, {}).get("subject"), str)
                or not settings[k]["subject"]
                for k in ("requester", "worker")
            )
            or settings["requester"]["subject"] == settings["worker"]["subject"]
        ):
            raise ValueError()
        entry = root / "src/inventory-server.ts"
        env["HAB_INVENTORY_CONFIG"] = str(path)
    # No fallback to visible input if terminal echo cannot be disabled.
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        token = getpass.getpass("Approved short-lived worker access token (hidden): ")
    authorization = token if token.startswith("Bearer ") else "Bearer " + token
    if len(authorization) > 16384 or not re.fullmatch(
        r"Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", authorization
    ):
        raise ValueError()
    payload = json.dumps({"authorization": authorization})
    try:
        if action == "--verify-worker":
            result = subprocess.run(
                [str(node), str(entry)],
                cwd=root,
                env=env,
                input=payload,
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode != 0:
                raise ValueError()
            candidate = json.loads(result.stdout)
            allowed = {
                "kind",
                "issuer",
                "resource",
                "subject",
                "clientId",
                "issuedAt",
                "expiresAt",
                "scopes",
                "enrolled",
            }
            if (
                set(candidate) != allowed
                or candidate["enrolled"] is not False
                or candidate["kind"] != "verified_worker_candidate"
            ):
                raise ValueError()
            print(json.dumps(candidate))
            return 0
        # Prompt before starting Node, whose stdin input deadline is only 3 seconds.
        return subprocess.run(
            [str(node), str(entry)],
            cwd=root,
            env=env,
            input=payload,
            text=True,
            check=False,
        ).returncode
    finally:
        token = authorization = payload = ""


if __name__ == "__main__":
    try:
        code = main()
    except (
        ValueError,
        OSError,
        KeyError,
        TypeError,
        EOFError,
        KeyboardInterrupt,
        getpass.GetPassWarning,
    ):
        print(
            "Owner input rejected; check approved action and private config.",
            file=sys.stderr,
        )
        code = 1
    sys.exit(code)
