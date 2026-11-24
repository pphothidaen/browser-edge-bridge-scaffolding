"""Unit and integration tests for scripts/build-extension.py."""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build-extension.py"
SRC_DIR = ROOT / "packages" / "core" / "browser-bridge" / "extension"


def _load_module():
    spec = importlib.util.spec_from_file_location("build_extension", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BuildExtensionTests(unittest.TestCase):
    def test_missing_token_fails_fast(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "built"
            env = {k: v for k, v in os.environ.items() if k not in ("BRIDGE_AUTH_TOKEN", "BRIDGE_SECRET", "DOPPLER_PROJECT", "DOPPLER_CONFIG")}
            res = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "--output", str(out_dir)],
                capture_output=True,
                text=True,
                env=env,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("BRIDGE_AUTH_TOKEN", res.stderr)
            self.assertFalse(out_dir.exists())

    def test_dummy_token_build_and_zip_preserves_source_placeholder(self):
        dummy_token = "dummy-bridge-secret-token"
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "browser-bridge-chrome-built"
            zip_path = Path(tmp) / "browser-bridge-chrome-built.zip"
            env = {**os.environ, "BRIDGE_AUTH_TOKEN": dummy_token}
            env.pop("DOPPLER_PROJECT", None)
            env.pop("DOPPLER_CONFIG", None)

            res = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "--output", str(out_dir), "--zip", str(zip_path)],
                capture_output=True,
                text=True,
                env=env,
            )
            self.assertEqual(res.returncode, 0, msg=f"stderr={res.stderr}\nstdout={res.stdout}")
            self.assertTrue((out_dir / "manifest.json").is_file())
            self.assertTrue(zip_path.is_file())

            built_bg = (out_dir / "background.js").read_text(encoding="utf-8")
            self.assertIn(dummy_token, built_bg)
            self.assertNotIn("__BRIDGE_AUTH_TOKEN__", built_bg)

            # Source tree MUST still keep the safe placeholder (GUARDRAILS G1)
            src_bg = (SRC_DIR / "background.js").read_text(encoding="utf-8")
            self.assertIn("__BRIDGE_AUTH_TOKEN__", src_bg)
            self.assertNotIn(dummy_token, src_bg)

            # Built JS must be syntactically valid
            syntax = subprocess.run(["node", "--check", str(out_dir / "background.js")], capture_output=True, text=True)
            self.assertEqual(syntax.returncode, 0, msg=syntax.stderr)

            # Built ZIP must be valid and contain background.js + manifest.json
            with zipfile.ZipFile(zip_path, "r") as zf:
                self.assertIsNone(zf.testzip())
                names = set(zf.namelist())
                self.assertIn("manifest.json", names)
                self.assertIn("background.js", names)

    def test_unsafe_token_characters_rejected(self):
        bad_tokens = (
            "bad'token",
            'bad"token',
            "bad\\token",
            "bad\ntoken",
            "bad\ttoken",
            "bad\x0btoken",
            "bad\x7ftoken",
            "bad`token",
            "bad\u2028token",
            "bad\u00e9token",
            "   ",
            " leading-space",
            "trailing-space ",
            "__DUMMY_TOKEN__",
        )
        for bad_token in bad_tokens:
            with self.subTest(bad_token=bad_token), tempfile.TemporaryDirectory() as tmp:
                out_dir = Path(tmp) / "built"
                env = {k: v for k, v in os.environ.items() if k not in ("DOPPLER_PROJECT", "DOPPLER_CONFIG", "BRIDGE_SECRET")}
                env["BRIDGE_AUTH_TOKEN"] = bad_token
                res = subprocess.run(
                    [sys.executable, str(SCRIPT_PATH), "--output", str(out_dir)],
                    capture_output=True,
                    text=True,
                    env=env,
                )
                self.assertNotEqual(res.returncode, 0, msg=f"unsafe token {bad_token!r} should be rejected")
                self.assertRegex(res.stderr.lower(), r"unsafe|invalid|character|placeholder|whitespace|empty|ascii")
                self.assertFalse(out_dir.exists(), msg=f"output dir must not be created when token {bad_token!r} fails")

    def test_zip_inside_output_dir_rejected_before_writing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "built"
            bad_zip = out_dir / "recursive.zip"
            env = {**os.environ, "BRIDGE_AUTH_TOKEN": "dummy-bridge-secret-token"}
            env.pop("DOPPLER_PROJECT", None)
            env.pop("DOPPLER_CONFIG", None)
            res = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "--output", str(out_dir), "--zip", str(bad_zip)],
                capture_output=True,
                text=True,
                env=env,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("outside", res.stderr.lower())
            self.assertFalse(out_dir.exists(), "output directory must not be created before zip path validation fails")

    def test_output_overlapping_source_dir_rejected(self):
        mod = _load_module()
        with tempfile.TemporaryDirectory() as tmp:
            fake_parent = Path(tmp) / "repo"
            fake_src = fake_parent / "extension"
            fake_src.mkdir(parents=True)
            (fake_src / "manifest.json").write_text('{"manifest_version": 3, "version": "0.8.5"}', encoding="utf-8")
            (fake_src / "background.js").write_text("const T = '__BRIDGE_AUTH_TOKEN__';\n", encoding="utf-8")
            orig_src = mod.SRC_DIR
            old_tok = os.environ.get("BRIDGE_AUTH_TOKEN")
            try:
                mod.SRC_DIR = fake_src
                os.environ["BRIDGE_AUTH_TOKEN"] = "dummy-bridge-secret-token"
                for dangerous_out in (fake_src, fake_parent, fake_src / "nested"):
                    with self.subTest(dangerous_out=str(dangerous_out)):
                        with self.assertRaises(SystemExit) as ctx:
                            mod.build_extension(dangerous_out, "", "")
                        self.assertNotEqual(ctx.exception.code, 0)
                        self.assertTrue((fake_src / "manifest.json").is_file(), "source directory must remain intact")
            finally:
                mod.SRC_DIR = orig_src
                if old_tok is None:
                    os.environ.pop("BRIDGE_AUTH_TOKEN", None)
                else:
                    os.environ["BRIDGE_AUTH_TOKEN"] = old_tok

    def test_missing_source_manifest_fails_fast(self):
        mod = _load_module()
        with tempfile.TemporaryDirectory() as tmp:
            empty_src = Path(tmp) / "empty-src"
            empty_src.mkdir()
            out_dir = Path(tmp) / "out"
            orig_src = mod.SRC_DIR
            old_tok = os.environ.get("BRIDGE_AUTH_TOKEN")
            try:
                mod.SRC_DIR = empty_src
                os.environ["BRIDGE_AUTH_TOKEN"] = "dummy-bridge-secret-token"
                with self.assertRaises(SystemExit) as ctx:
                    mod.build_extension(out_dir, "", "")
                self.assertNotEqual(ctx.exception.code, 0)
            finally:
                mod.SRC_DIR = orig_src
                if old_tok is None:
                    os.environ.pop("BRIDGE_AUTH_TOKEN", None)
                else:
                    os.environ["BRIDGE_AUTH_TOKEN"] = old_tok


if __name__ == "__main__":
    unittest.main()
