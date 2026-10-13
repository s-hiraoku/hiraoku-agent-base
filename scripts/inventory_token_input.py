"""Manual worker-token handoff; never issues tokens or submits a task."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import warnings

MAX_AUTH_BYTES = 16384
MAX_STDIN_BYTES = 17000
ENTRY = Path(__file__).resolve().parents[1] / "src" / "inventory-server.ts"


class Rejected(Exception):
    """Messages are fixed labels, never input or child output."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Rejected("inventory_input_arguments_rejected")


def check_config(path):
    path = Path(path)
    if not path.is_absolute():
        raise Rejected("inventory_input_config_rejected")
    before = path.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.getuid()
        or before.st_mode & 0o077
        or before.st_size > 65536
    ):
        raise Rejected("inventory_input_config_rejected")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as file:
        opened = os.fstat(file.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_ctime_ns) != (
            before.st_dev,
            before.st_ino,
            before.st_ctime_ns,
        ):
            raise Rejected("inventory_input_config_rejected")
        config = json.loads(file.read(65537))
    if (
        not isinstance(config, dict)
        or config.get("mode") != "inventory-one-shot"
        or config.get("enabled") is not True
    ):
        raise Rejected("inventory_input_config_rejected")
    return str(path)


def encode_authorization(authorization):
    if (
        not isinstance(authorization, str)
        or len(authorization.encode("utf-8")) > MAX_AUTH_BYTES
        or not re.fullmatch(
            r"Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", authorization
        )
    ):
        raise Rejected("inventory_input_token_rejected")
    payload = bytearray(
        json.dumps({"authorization": authorization}, separators=(",", ":")).encode(
            "ascii"
        )
    )
    if len(payload) > MAX_STDIN_BYTES:
        raise Rejected("inventory_input_token_rejected")
    return payload


def stop_child(child):
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        child.kill()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            raise Rejected("inventory_input_stop_uncertain") from None


def handoff(
    config, node, *, reader=None, stdin=None, stderr=None, spawn=None, timeout=130
):
    stdin = sys.stdin if stdin is None else stdin
    stderr = sys.stderr if stderr is None else stderr
    if not stdin.isatty() or not stderr.isatty():
        raise Rejected("inventory_input_tty_required")
    config = check_config(config)
    node = Path(node)
    if not node.is_absolute() or not node.is_file() or not node.stat().st_mode & 0o111:
        raise Rejected("inventory_input_node_rejected")
    node = str(node.resolve(strict=True))
    reader = getpass.getpass if reader is None else reader
    payload = None
    child = None
    try:
        # getpass's echo fallback is forbidden, even if isatty() returned True.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            authorization = reader(
                "Existing worker Bearer token (hidden): ", stream=stderr
            )
        payload = encode_authorization(authorization)
        authorization = ""
        child = (subprocess.Popen if spawn is None else spawn)(
            [node, str(ENTRY)],
            cwd=str(ENTRY.parents[1]),
            env={"PATH": os.defpath, "HAB_INVENTORY_CONFIG": config},
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        child.communicate(input=payload, timeout=timeout)
        if child.returncode != 0:
            raise Rejected("inventory_input_child_failed")
    except (getpass.GetPassWarning, EOFError):
        raise Rejected("inventory_input_hidden_read_failed") from None
    except subprocess.TimeoutExpired:
        raise Rejected("inventory_input_child_timeout") from None
    finally:
        if payload is not None:
            payload[:] = b"\x00" * len(payload)
        if child is not None:
            stop_child(child)


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument(
        "--config", required=True, help="Approved private active config path"
    )
    parser.add_argument(
        "--node", required=True, help="Reviewed absolute Node 24+ executable path"
    )
    try:
        args = parser.parse_args(argv)
        handoff(args.config, args.node)
    except KeyboardInterrupt:
        print("inventory_input_cancelled", file=sys.stderr)
        return 1
    except Rejected as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("inventory_input_failed", file=sys.stderr)
        return 1
    print("inventory_entry_exited")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
