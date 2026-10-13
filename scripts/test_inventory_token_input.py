import contextlib
import getpass
import io
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import warnings

from scripts import inventory_token_input as helper

DUMMY = "Bearer dummy_header.dummy_payload.dummy_signature"


class TTY(io.StringIO):
    def isatty(self):
        return True


class TokenInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name) / "approved.local.json"
        self.config.write_text(
            json.dumps({"mode": "inventory-one-shot", "enabled": True})
        )
        self.config.chmod(0o600)
        self.options = dict(stdin=TTY(), stderr=TTY(), reader=lambda *a, **k: DUMMY)

    def call(self, **kwargs):
        return helper.handoff(
            str(self.config), sys.executable, **(self.options | kwargs)
        )

    def test_real_child_receives_bounded_stdin_not_argv_env_or_output(self):
        seen = {}

        def spawn(args, **kwargs):
            seen.update(args=args, **kwargs)
            code = "import sys,json,os; d=sys.stdin.buffer.read(17001); assert len(d)<=17000; v=json.loads(d)['authorization']; assert v not in str(sys.argv); assert 'SECRET_TEST' not in os.environ; print(v); print(v,file=sys.stderr)"
            return subprocess.Popen([sys.executable, "-c", code], **kwargs)

        with patch.dict(os.environ, {"SECRET_TEST": DUMMY}):
            self.call(spawn=spawn)
        self.assertNotIn(DUMMY, str(seen["args"]))
        self.assertEqual(set(seen["env"]), {"PATH", "HAB_INVENTORY_CONFIG"})
        self.assertEqual(seen["stdin"], subprocess.PIPE)
        self.assertEqual(seen["stdout"], subprocess.DEVNULL)
        self.assertEqual(seen["stderr"], subprocess.DEVNULL)

    def test_non_tty_refuses_before_read_or_spawn(self):
        reader, spawn = unittest.mock.Mock(), unittest.mock.Mock()
        for stream in ["stdin", "stderr"]:
            with (
                self.subTest(stream=stream),
                self.assertRaisesRegex(helper.Rejected, "tty_required"),
            ):
                self.call(**{stream: io.StringIO()}, reader=reader, spawn=spawn)
        reader.assert_not_called()
        spawn.assert_not_called()

    def test_getpass_echo_fallback_is_rejected(self):
        def reader(*args, **kwargs):
            warnings.warn("dummy fallback", getpass.GetPassWarning)
            return DUMMY

        spawn = unittest.mock.Mock()
        with self.assertRaisesRegex(helper.Rejected, "hidden_read_failed"):
            self.call(reader=reader, spawn=spawn)
        spawn.assert_not_called()

    def test_invalid_and_oversized_inputs_never_spawn(self):
        spawn = unittest.mock.Mock()
        for value in [DUMMY + "\n", "not-a-token", "Bearer " + "x" * 16384 + ".x.x"]:
            with (
                self.subTest(length=len(value)),
                self.assertRaisesRegex(helper.Rejected, "token_rejected"),
            ):
                self.call(reader=lambda *a, **k: value, spawn=spawn)
        spawn.assert_not_called()

    def test_disabled_public_or_symlink_config_never_prompts(self):
        reader = unittest.mock.Mock()
        self.config.chmod(0o644)
        with self.assertRaisesRegex(helper.Rejected, "config_rejected"):
            self.call(reader=reader)
        self.config.chmod(0o600)
        self.config.write_text('{"mode":"inventory-metadata","enabled":false}')
        with self.assertRaisesRegex(helper.Rejected, "config_rejected"):
            self.call(reader=reader)
        link = Path(self.temp.name) / "link.local.json"
        link.symlink_to(self.config)
        with self.assertRaisesRegex(helper.Rejected, "config_rejected"):
            helper.handoff(
                str(link), sys.executable, **(self.options | {"reader": reader})
            )
        reader.assert_not_called()

    def test_payload_buffer_is_cleared_after_child_failure(self):
        class Child:
            returncode = 7

            def communicate(self, *, input, timeout):
                self.buffer = input
                self.received = json.loads(bytes(input))["authorization"]

            def poll(self):
                return self.returncode

        child = Child()
        with self.assertRaisesRegex(helper.Rejected, "child_failed"):
            self.call(spawn=lambda *a, **k: child)
        self.assertEqual(child.received, DUMMY)
        self.assertEqual(child.buffer, bytearray(len(child.buffer)))

    def test_timeout_terminates_real_owned_child(self):
        seen = []

        def spawn(args, **kwargs):
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import sys,time; sys.stdin.buffer.read(); time.sleep(30)",
                ],
                **kwargs,
            )
            seen.append(child)
            return child

        with self.assertRaisesRegex(helper.Rejected, "child_timeout"):
            self.call(spawn=spawn, timeout=0.1)
        self.assertIsNotNone(seen[0].poll())

    def test_uncertain_stop_is_reported(self):
        child = unittest.mock.Mock()
        child.poll.return_value = None
        child.wait.side_effect = subprocess.TimeoutExpired("dummy", 2)
        with self.assertRaisesRegex(helper.Rejected, "stop_uncertain"):
            helper.stop_child(child)
        child.terminate.assert_called_once()
        child.kill.assert_called_once()

    @unittest.skipUnless(os.name == "posix", "POSIX Ctrl-C cleanup")
    def test_spawned_child_cancel_and_second_sigint_still_confirms_kill(self):
        entry = Path(self.temp.name) / "ignore_term_fixture.py"
        ready = Path(self.temp.name) / "ready"
        entry.write_text(
            "import signal,sys,time; from pathlib import Path; "
            "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            f"Path({str(ready)!r}).touch(); "
            "sys.stdin.buffer.read(); time.sleep(30)\n"
        )
        original_spawn = subprocess.Popen
        previous = signal.getsignal(signal.SIGINT)
        seen, senders = [], []
        cleanup_started = threading.Event()
        signals_sent = []

        def spawn(args, **kwargs):
            child = original_spawn(args, **kwargs)
            seen.append(child)
            original_terminate = child.terminate

            def terminate():
                original_terminate()
                cleanup_started.set()

            child.terminate = terminate
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists())

            def interrupt_twice():
                time.sleep(0.1)
                os.kill(os.getpid(), signal.SIGINT)
                signals_sent.append(1)
                if cleanup_started.wait(timeout=5):
                    os.kill(os.getpid(), signal.SIGINT)
                    signals_sent.append(2)

            sender = threading.Thread(target=interrupt_twice)
            senders.append(sender)
            sender.start()
            return child

        output = TTY()
        try:
            with (
                patch.object(helper, "ENTRY", entry),
                patch.object(helper.subprocess, "Popen", side_effect=spawn),
                patch.object(helper.getpass, "getpass", return_value=DUMMY),
                patch.object(sys, "stdin", TTY()),
                patch.object(sys, "stderr", output),
            ):
                result = helper.main(
                    ["--config", str(self.config), "--node", sys.executable]
                )
            for sender in senders:
                sender.join(timeout=5)
                self.assertFalse(sender.is_alive())
            self.assertEqual(result, 1)
            self.assertEqual(signals_sent, [1, 2])
            self.assertEqual(seen[0].poll(), -signal.SIGKILL)
            self.assertEqual(signal.getsignal(signal.SIGINT), previous)
            self.assertIn("inventory_input_cancelled", output.getvalue())
            self.assertNotIn(DUMMY, output.getvalue())
        finally:
            for child in seen:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)

    def test_stop_os_error_is_uncertain_and_restores_handler(self):
        previous = signal.getsignal(signal.SIGINT)
        child = unittest.mock.Mock()
        child.poll.return_value = None
        child.terminate.side_effect = OSError("dummy-only")
        with self.assertRaisesRegex(helper.Rejected, "stop_uncertain"):
            helper.stop_child(child)
        self.assertEqual(signal.getsignal(signal.SIGINT), previous)

    def test_cancel_before_input_never_spawns(self):
        spawn = unittest.mock.Mock()
        with self.assertRaises(KeyboardInterrupt):
            self.call(
                reader=unittest.mock.Mock(side_effect=KeyboardInterrupt), spawn=spawn
            )
        spawn.assert_not_called()

    def test_cli_errors_and_argument_errors_never_print_input(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.assertEqual(helper.main(["--secret", DUMMY]), 1)
            with patch.object(helper, "handoff", side_effect=RuntimeError(DUMMY)):
                self.assertEqual(
                    helper.main(
                        ["--config", str(self.config), "--node", sys.executable]
                    ),
                    1,
                )
        self.assertNotIn(DUMMY, output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())

    @unittest.skipUnless(os.name == "posix", "POSIX Terminal handoff")
    def test_real_tty_getpass_does_not_echo_dummy_token(self):
        entry = Path(self.temp.name) / "no_service_fixture.py"
        entry.write_text(
            "import json,sys; assert json.loads(sys.stdin.buffer.read(17001))['authorization'].startswith('Bearer ')\n"
        )
        code = (
            "from pathlib import Path; from scripts import inventory_token_input as h; "
            f"h.ENTRY=Path({str(entry)!r}); "
            f"raise SystemExit(h.main(['--config',{str(self.config)!r},'--node',{sys.executable!r}]))"
        )
        pid, fd = pty.fork()
        if pid == 0:
            os.execv(sys.executable, [sys.executable, "-B", "-c", code])
        output, sent, finished = bytearray(), False, False
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                    if b"(hidden): " in output and not sent:
                        os.write(fd, (DUMMY + "\n").encode())
                        sent = True
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    finished = True
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    break
            if not finished:
                # PTY EOF can precede the kernel's child-exit notification.
                while time.monotonic() < deadline:
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done:
                        finished = True
                        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                        break
                    time.sleep(0.01)
            self.assertTrue(finished)
            self.assertTrue(sent)
            self.assertNotIn(DUMMY.encode(), output)
            self.assertIn(b"inventory_entry_exited", output)
        finally:
            os.close(fd)
            if not finished:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)


if __name__ == "__main__":
    unittest.main()
