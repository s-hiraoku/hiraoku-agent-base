"""Synthetic terminal/config/child mocks; no installed token or live process."""

import contextlib
import getpass
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from hermes_bridge import owner_input


class OwnerInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.node = self.root / "trusted-node"
        self.node.write_text("synthetic executable; subprocess is mocked")
        self.node.chmod(0o500)
        self.config = self.root / "identity.local.json"
        self.settings = {"mode": "verify-worker-identity"}
        self.config.write_text(json.dumps(self.settings))
        self.config.chmod(0o600)
        self.token = "synthetic.head.signature"
        self.candidate = {
            "kind": "verified_worker_candidate",
            "issuer": "https://fixture.us.auth0.com/",
            "resource": "https://hub.example/mcp",
            "subject": "fixture-service",
            "clientId": "fixture-worker",
            "issuedAt": 1,
            "expiresAt": 2,
            "scopes": ["hub:get", "hub:claim", "hub:heartbeat", "hub:complete"],
            "enrolled": False,
        }

    def tearDown(self):
        self.tmp.cleanup()

    def invoke(self, *, tty=True, run=None, prompt=None, action="--verify-worker"):
        with (
            patch.object(
                sys, "argv", ["owner_input", action, str(self.config), str(self.node)]
            ),
            patch.object(sys.stdin, "isatty", return_value=tty),
            patch.object(sys.stderr, "isatty", return_value=tty),
            patch.object(
                owner_input.getpass, "getpass", prompt or Mock(return_value=self.token)
            ),
            patch.object(
                owner_input.subprocess,
                "run",
                run or Mock(return_value=subprocess.CompletedProcess([], 0, b"ok")),
            ),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            value = owner_input.main()
            return value, out.getvalue()

    def test_hidden_token_goes_only_to_stdin_and_candidate_only_to_stdout(self):
        run = Mock(
            side_effect=[
                subprocess.CompletedProcess([], 0, b"ok"),
                subprocess.CompletedProcess([], 0, json.dumps(self.candidate), ""),
            ]
        )
        value, output = self.invoke(run=run)
        self.assertEqual(value, 0)
        self.assertEqual(json.loads(output), self.candidate)
        self.assertNotIn(self.token, output)
        calls = run.call_args_list
        self.assertEqual(len(calls), 2)
        args, kwargs = calls[1]
        self.assertNotIn(self.token, json.dumps(args))
        self.assertNotIn(self.token, json.dumps(kwargs["env"]))
        self.assertEqual(
            json.loads(kwargs["input"]), {"authorization": "Bearer " + self.token}
        )
        self.assertEqual(set(kwargs["env"]), {"PATH", "HAB_WORKER_IDENTITY_CONFIG"})
        self.assertNotIn("shell", kwargs)
        self.assertEqual(json.loads(self.config.read_text()), self.settings)

    def test_nonterminal_input_cannot_prompt_or_pass_token(self):
        prompt = Mock()
        run = Mock(return_value=subprocess.CompletedProcess([], 0, b"ok"))
        with self.assertRaises(ValueError):
            self.invoke(tty=False, run=run, prompt=prompt)
        prompt.assert_not_called()
        run.assert_not_called()

    def test_echo_fallback_is_fatal(self):
        def unsafe_prompt(*args):
            import warnings

            warnings.warn("echo fallback", getpass.GetPassWarning)
            return self.token

        run = Mock(return_value=subprocess.CompletedProcess([], 0, b"ok"))
        with self.assertRaises(getpass.GetPassWarning):
            self.invoke(run=run, prompt=unsafe_prompt)
        self.assertEqual(run.call_count, 1)

    def test_failed_child_or_unexpected_output_is_not_echoed(self):
        for result in (
            subprocess.CompletedProcess([], 1, "PRIVATE_SENTINEL", "PRIVATE_SENTINEL"),
            subprocess.CompletedProcess(
                [], 0, json.dumps({**self.candidate, "token": "PRIVATE_SENTINEL"}), ""
            ),
        ):
            run = Mock(side_effect=[subprocess.CompletedProcess([], 0, b"ok"), result])
            out = io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(ValueError):
                self.invoke(run=run)
            self.assertEqual(out.getvalue(), "")

    def test_unsafe_config_and_unfinalized_inventory_refuse_before_prompt(self):
        run = Mock()
        self.config.chmod(0o644)
        with self.assertRaises(ValueError):
            self.invoke(run=run)
        run.assert_not_called()
        self.config.chmod(0o600)
        with self.assertRaises(ValueError):
            self.invoke(run=run, action="--run-inventory")
        run.assert_not_called()

    def test_inventory_mode_is_manual_and_passes_already_acquired_token_only(self):
        settings = {
            "mode": "inventory-one-shot",
            "enabled": True,
            "requester": {"subject": "fixture-reader"},
            "worker": {"subject": "fixture-worker"},
        }
        self.config.write_text(json.dumps(settings))
        self.config.chmod(0o600)
        run = Mock(return_value=subprocess.CompletedProcess([], 0))
        self.assertEqual(self.invoke(run=run, action="--run-inventory")[0], 0)
        self.assertEqual(run.call_count, 1)
        args, kwargs = run.call_args
        self.assertTrue(args[0][1].endswith("src/inventory-server.ts"))
        self.assertEqual(set(kwargs["env"]), {"PATH", "HAB_INVENTORY_CONFIG"})
        self.assertEqual(
            json.loads(kwargs["input"]), {"authorization": "Bearer " + self.token}
        )


if __name__ == "__main__":
    unittest.main()
