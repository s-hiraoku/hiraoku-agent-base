import hashlib
import json
import tempfile
import unittest
import subprocess
import sys
import errno
import os
from unittest.mock import patch
from pathlib import Path
from hermes_bridge.serve_inventory import (
    validate_manifest,
    verify_code_trees,
    verify_import_paths,
    validate_import_contract,
    require_not_writable,
)


# Write-denial checks rely on file permissions, which root bypasses.
requires_non_root = unittest.skipIf(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    "requires a non-root user: root bypasses file write denial",
)


class LaunchTests(unittest.TestCase):
    @requires_non_root
    def test_immutable_code_hash_and_drift_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "source.py"
            file.write_text("reviewed public fixture")
            entries = [
                ["", "directory"],
                ["source.py", hashlib.sha256(file.read_bytes()).hexdigest()],
            ]
            tree = {
                "root": str(root),
                "sha256": hashlib.sha256(
                    json.dumps(entries, separators=(",", ":")).encode()
                ).hexdigest(),
            }
            file.chmod(0o400)
            root.chmod(0o500)
            try:
                verify_code_trees([tree])
                with self.assertRaises(ValueError):
                    verify_code_trees([{**tree, "sha256": "f" * 64}])
                file.chmod(0o600)
                with self.assertRaises(ValueError):
                    verify_code_trees([tree])
            finally:
                root.chmod(0o700)

    def test_unmeasured_or_implicit_python_import_roots_are_rejected(self):
        trees = [{"root": "/reviewed/runtime"}]
        verify_import_paths(
            ["/reviewed/runtime/lib", "/reviewed/runtime/python.zip"], trees
        )
        for paths in ([""], ["relative"], ["/unmeasured/site-packages"]):
            with self.assertRaises(ValueError):
                verify_import_paths(paths, trees)

    def test_launch_manifest_exact_budgets_model_tools_and_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            wrapper = root / "serve_inventory.py"
            python = root / "python"
            dependencies = root.parent / (root.name + "-dependencies")
            trees = [
                {"root": str(root), "sha256": "a" * 64},
                {
                    "root": str(dependencies),
                    "sha256": "b" * 64,
                    "fixedDependencies": True,
                },
            ]
            manifest = {
                "contract": "hermes-agent-inventory-v1",
                "endpoint": "http://127.0.0.1:8645/",
                "profileRoot": str(root),
                "sourceRoot": str(root),
                "dependencyRoot": str(dependencies),
                "pythonIsolation": "isolated-no-site-v1",
                "wrapperPath": str(wrapper),
                "pythonPath": str(python),
                "model": "gpt-6.1-sol",
                "provider": "openai-codex",
                "tools": ["hub_shift_log_inventory"],
                "maxIterations": 3,
                "maxTokens": 256,
                "runBudgetSeconds": 60,
                "concurrency": 1,
                "evidencePath": str(root / "inventory-evidence.sqlite"),
                "runStorePath": str(root / "runs_idempotency.db"),
                "memory": False,
                "history": False,
                "fallback": False,
                "startup": "manual-one-shot",
                "maxTasks": 1,
                "apiKeyDigest": "a" * 64,
                "sourceCommit": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
                "codeTrees": trees,
            }
            kwargs = {
                "profile": root,
                "wrapper": wrapper,
                "python": python,
                "credential_digest": "a" * 64,
            }
            self.assertEqual(validate_manifest(manifest, **kwargs), manifest)
            for defect in (
                {"model": "other"},
                {"tools": ["shell"]},
                {"maxTasks": 2},
                {"maxTokens": 257},
                {"endpoint": "http://0.0.0.0:8645/"},
                {"history": True},
                {"codeTrees": []},
                {"pythonIsolation": "isolated-only"},
                {"dependencyRoot": "/unmeasured"},
            ):
                with self.assertRaises(ValueError):
                    validate_manifest({**manifest, **defect}, **kwargs)

    @requires_non_root
    def test_fixed_dependencies_reject_pth_editable_and_direct_url_loaders(self):
        for name in (
            "inject.pth",
            "inject.egg-link",
            "__editable__.fixture.py",
            "direct_url.json",
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                file = root / name
                file.write_text("must never execute")
                file.chmod(0o400)
                root.chmod(0o500)
                try:
                    with self.assertRaisesRegex(
                        ValueError, "dependency_loader_rejected"
                    ):
                        verify_code_trees(
                            [
                                {
                                    "root": str(root),
                                    "sha256": "a" * 64,
                                    "fixedDependencies": True,
                                }
                            ]
                        )
                finally:
                    root.chmod(0o700)

    def test_no_site_bootstrap_ignores_pth_pythonpath_user_site_and_cwd(self):
        wrapper = str(Path("hermes_bridge/serve_inventory.py").resolve())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            marker = root / "executed"
            (root / "inject.pth").write_text(
                "import pathlib; pathlib.Path(" + repr(str(marker)) + ").touch()"
            )
            (root / "sitecustomize.py").write_text(
                "raise RuntimeError('unapproved site ran')"
            )
            (root / "unapproved.py").write_text("raise RuntimeError('cwd ran')")
            program = (
                "import importlib.util,sys; "
                "spec=importlib.util.spec_from_file_location('guard',"
                + repr(wrapper)
                + "); "
                "guard=importlib.util.module_from_spec(spec); spec.loader.exec_module(guard); "
                "guard.verify_python_bootstrap(); "
                "assert importlib.util.find_spec('unapproved') is None; "
                "assert 'site' not in sys.modules; "
                "assert not any('site-packages' in p for p in sys.path); "
                "print('isolated_no_site_verified')"
            )
            result = subprocess.run(
                [sys.executable, "-I", "-S", "-c", program],
                cwd=root,
                env={"PYTHONPATH": str(root), "PYTHONUSERBASE": str(root)},
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(result.stdout.strip(), "isolated_no_site_verified")
            self.assertFalse(marker.exists())
            for injection in (
                "sys.meta_path.append(object())",
                "sys.modules['site']=object()",
            ):
                bad = program.replace(
                    "guard.verify_python_bootstrap();",
                    injection + "; guard.verify_python_bootstrap();",
                )
                result = subprocess.run(
                    [sys.executable, "-I", "-S", "-c", bad],
                    cwd=root,
                    text=True,
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("inventory_python_", result.stderr)
            result = subprocess.run(
                [sys.executable, "-I", "-c", program],
                cwd=root,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("inventory_python_bootstrap_rejected", result.stderr)

    def test_no_site_prevents_actual_venv_pth_and_editable_hook_execution(self):
        wrapper = str(Path("hermes_bridge/serve_inventory.py").resolve())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            binary = root / "bin" / "python"
            binary.parent.mkdir()
            binary.symlink_to(sys.executable)
            (root / "pyvenv.cfg").write_text(
                "home = "
                + str(Path(sys.executable).parent)
                + "\ninclude-system-site-packages = false\n"
            )
            packages = (
                root
                / "lib"
                / (
                    "python"
                    + str(sys.version_info.major)
                    + "."
                    + str(sys.version_info.minor)
                )
                / "site-packages"
            )
            packages.mkdir(parents=True)
            marker = root / "editable_executed"
            (packages / "__editable__.fixture.pth").write_text(
                "import pathlib,sys; pathlib.Path("
                + repr(str(marker))
                + ").touch(); sys.meta_path.append(object())\n"
            )
            subprocess.run(
                [str(binary), "-I", "-c", "pass"], check=True, capture_output=True
            )
            self.assertTrue(
                marker.exists(), "fixture must exercise an actual site .pth loader"
            )
            marker.unlink()
            program = (
                "import importlib.util; spec=importlib.util.spec_from_file_location('guard',"
                + repr(wrapper)
                + "); guard=importlib.util.module_from_spec(spec); "
                "spec.loader.exec_module(guard); guard.verify_python_bootstrap()"
            )
            subprocess.run(
                [str(binary), "-I", "-S", "-c", program],
                check=True,
                capture_output=True,
            )
            self.assertFalse(marker.exists())

    def test_shared_excluded_and_implicit_import_paths_stay_rejected(self):
        trees = [
            {
                "root": "/reviewed/lib",
                "systemRuntime": True,
                "excludedSystemSitePackages": "python3.11/site-packages",
            }
        ]
        verify_import_paths(
            ["/reviewed/lib/python3.11", "/reviewed/lib/python3.11/lib-dynload"], trees
        )
        for path in (
            "/reviewed/lib/python3.11/site-packages",
            "/reviewed/lib/python3.11/site-packages/injected",
            "__editable__.finder.__path_hook__",
            "",
            "/unapproved",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                verify_import_paths([path], trees)

    def test_dependency_and_exclusion_contract_refuses_reintroduction_and_size_relaxation(
        self,
    ):
        trees = [
            {
                "root": "/reviewed/lib",
                "sha256": "a" * 64,
                "systemRuntime": True,
                "excludedSystemSitePackages": "python3.11/site-packages",
                "maxBytes": 1024,
            },
            {
                "root": "/reviewed/dependencies",
                "sha256": "b" * 64,
                "fixedDependencies": True,
                "maxBytes": 1024,
            },
        ]
        manifest = {
            "sourceRoot": "/reviewed/source",
            "wrapperPath": "/reviewed/guard/serve_inventory.py",
            "dependencyRoot": "/reviewed/dependencies",
            "pythonIsolation": "isolated-no-site-v1",
            "codeTrees": trees,
        }
        validate_import_contract(manifest)
        defects = [
            {"dependencyRoot": "/reviewed/lib/python3.11/site-packages"},
            {"codeTrees": [trees[0], {**trees[1], "fixedDependencies": False}]},
            {"codeTrees": [{**trees[0], "systemRuntime": False}, trees[1]]},
            {"codeTrees": [{**trees[0], "maxBytes": 1073741825}, trees[1]]},
            {
                "codeTrees": [
                    {
                        **trees[0],
                        "aliases": {
                            "alias": "/reviewed/lib/python3.11/site-packages/injected"
                        },
                    },
                    trees[1],
                ]
            },
            {
                "codeTrees": trees
                + [
                    {
                        "root": "/reviewed/lib/python3.11/site-packages",
                        "sha256": "c" * 64,
                    }
                ]
            },
        ]
        for defect in defects:
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                validate_import_contract({**manifest, **defect})

    def test_write_probe_eperm_is_inconclusive_not_immutable(self):
        class Access:
            def __call__(self, *_):
                import ctypes

                ctypes.set_errno(errno.EPERM)
                return -1

        class Lib:
            access = Access()

        with patch("hermes_bridge.serve_inventory.ctypes.CDLL", return_value=Lib()):
            with self.assertRaises(OSError) as raised:
                require_not_writable(Path("/fixture"))
            self.assertEqual(raised.exception.errno, errno.EPERM)


if __name__ == "__main__":
    unittest.main()
