"""Regression tests for required CI and production-readiness gates."""

from pathlib import Path
import http.server
import json
import os
import re
import socketserver
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
CI_WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
JIRA_WORKFLOW = (ROOT / ".github/workflows/jira-sync.yml").read_text(encoding="utf-8")
BRIDGE_CHECK_WORKFLOW = (ROOT / ".github/workflows/bridge-check.yml").read_text(encoding="utf-8")
CI_PROBE = (ROOT / "scripts/ci_probe.sh").read_text(encoding="utf-8")
DOD_GATE = (ROOT / "scripts/dod_gate.sh").read_text(encoding="utf-8")
RELEASE_SCRIPT = (ROOT / "scripts/release.mjs").read_text(encoding="utf-8")
PLAN_DOC = (ROOT / "plan.md").read_text(encoding="utf-8")


class CIGateConfigurationTests(unittest.TestCase):
    def test_required_workflow_gates_are_blocking(self):
        for workflow_name, workflow in (
            ("ci.yml", CI_WORKFLOW),
            ("jira-sync.yml", JIRA_WORKFLOW),
        ):
            self.assertNotRegex(
                workflow,
                r"(?m)^\s*continue-on-error:\s*true\s*$",
                f"{workflow_name} must not ignore a required gate failure",
            )

        self.assertNotRegex(
            CI_WORKFLOW,
            r"(?m)^\s*npm audit[^\n]*\|\|\s*true\s*$",
            "dependency audit failures must fail CI",
        )
        self.assertNotIn(
            "|| git diff",
            BRIDGE_CHECK_WORKFLOW,
            "secret-scan diff lookup must fail explicitly when no diff is available",
        )
        self.assertNotIn(
            'TEXT="${{ github.event.pull_request.title }}"',
            JIRA_WORKFLOW,
            "untrusted PR title must not be interpolated into a shell script",
        )
        self.assertIn(
            "PR_TITLE: ${{ github.event.pull_request.title }}",
            JIRA_WORKFLOW,
        )
        self.assertIn('>> "$GITHUB_OUTPUT"', JIRA_WORKFLOW)
        self.assertIn(
            'zip -qr "../browser-bridge-v${VERSION}.zip" .',
            CI_WORKFLOW,
        )

    def test_deploy_secret_guard_is_preserved(self):
        self.assertIn("secrets.CLOUDFLARE_API_TOKEN", CI_WORKFLOW)
        self.assertIn("secrets.CLOUDFLARE_ACCOUNT_ID", CI_WORKFLOW)
        self.assertIn("secrets.BRIDGE_AUTH_TOKEN", CI_WORKFLOW)
        self.assertIn("steps.guard.outputs.skip == 'false'", CI_WORKFLOW)
        self.assertIn("github.event_name != 'pull_request'", CI_WORKFLOW)
        self.assertIn(
            "github.event.repository.private == true",
            CI_WORKFLOW,
            "token-bearing extension artifact uploads must be restricted to private repositories",
        )
        self.assertNotIn(
            'if [ -z "${{ secrets.CLOUDFLARE_API_TOKEN }}" ]',
            CI_WORKFLOW,
            "deploy guard should read secrets from env instead of shell-interpolating expressions",
        )

    def test_ci_runs_full_regression_and_dummy_token_build_smoke(self):
        self.assertIn('discover -s tests -p "test_*.py"', CI_WORKFLOW)
        self.assertIn("diff -rq packages/core/browser-bridge/extension release/chrome-extension", CI_WORKFLOW)
        self.assertNotIn("vscode-extension", CI_WORKFLOW)
        self.assertIn("scripts/build-extension.py", CI_WORKFLOW)
        self.assertIn("dummy-ci-smoke-token", CI_WORKFLOW)
        self.assertIn("scripts/verify_deploy.mjs", CI_WORKFLOW)
        self.assertNotIn("vscode-extension", RELEASE_SCRIPT)
        self.assertNotIn("rmSync(releaseDir,", RELEASE_SCRIPT)
        self.assertNotIn("POST /v1/mcp", PLAN_DOC)
        self.assertIn("POST /mcp", PLAN_DOC)

    def test_probes_do_not_use_hardcoded_api_key_or_swallow_curl_failures(self):
        self.assertNotRegex(
            CI_PROBE,
            r"BRIDGE_API_KEY:-",
            "production probe credentials must come from the environment",
        )
        self.assertNotRegex(
            CI_PROBE,
            r'(?m)^STATUS_URL="https://bridge\.example\.workers\.dev/status"$',
            "STATUS_URL must be overridable via environment variables",
        )
        self.assertNotIn(
            "gemini-3.1-flash-lite",
            CI_PROBE,
            "ci_probe.sh must use generic overridable BRIDGE_MODEL instead of a hardcoded vendor model",
        )
        self.assertNotRegex(
            CI_PROBE,
            r"curl[^\n]*\|\|\s*echo",
            "probe curl failures must remain observable",
        )
        self.assertRegex(CI_PROBE, r"curl -f\s+-s\s+-S")
        self.assertNotIn(
            'CHAT_ENDPOINT="${BRIDGE_BASE_URL}/chat"',
            DOD_GATE,
            "DoD gate must target the real /v1/chat/completions worker route",
        )
        self.assertNotIn(
            "mapfile",
            DOD_GATE,
            "dod_gate.sh must stay compatible with macOS Bash 3.2 (avoid Bash 4+ mapfile)",
        )
        self.assertIn("/v1/chat/completions", DOD_GATE)
        self.assertIn("Authorization: Bearer", DOD_GATE)
        self.assertNotIn(
            "|| echo",
            DOD_GATE,
            "DoD curl failures must remain observable",
        )
        self.assertRegex(DOD_GATE, r"curl -f\s+-s\s+-S")

    def test_probe_scripts_execute_cleanly_against_mock_worker(self):
        seen = {"chat_models": [], "mcp_models": [], "auth_headers": []}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                if self.path == "/status":
                    payload = {"ok": True, "extension": "CONNECTED", "extensions": 1}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(payload).encode("utf-8"))
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                seen["auth_headers"].append(self.headers.get("Authorization", ""))
                if self.path == "/mcp":
                    seen["mcp_models"].append(body.get("params", {}).get("arguments", {}).get("model"))
                    payload = {"jsonrpc": "2.0", "id": body.get("id", 1), "result": {"content": [{"type": "text", "text": "status ok"}]}}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(payload).encode("utf-8"))
                    return
                if self.path == "/v1/chat/completions":
                    seen["chat_models"].append(body.get("model"))
                    payload = {"choices": [{"message": {"role": "assistant", "content": "pong"}}]}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(payload).encode("utf-8"))
                    return
                self.send_response(404)
                self.end_headers()

        with socketserver.TCPServer(("127.0.0.1", 0), Handler) as srv:
            port = srv.server_address[1]
            thread = threading.Thread(target=srv.serve_forever, daemon=True)
            thread.start()
            try:
                base_url = f"http://127.0.0.1:{port}"
                with tempfile.TemporaryDirectory() as bin_dir:
                    hermes_stub = Path(bin_dir) / "hermes"
                    hermes_stub.write_text(
                        "#!/usr/bin/env bash\n"
                        "echo 'Connected to browser-edge-bridge'\n"
                        "echo 'Tools discovered: 5'\n",
                        encoding="utf-8",
                    )
                    hermes_stub.chmod(0o755)
                    env = {
                        **os.environ,
                        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                        "BRIDGE_BASE_URL": base_url,
                        "BRIDGE_API_KEY": "dummy-client-api-key",
                        "STATUS_PROBES": "5",
                    }
                    ci_res = subprocess.run(["bash", str(ROOT / "scripts/ci_probe.sh")], capture_output=True, text=True, env=env)
                    self.assertEqual(ci_res.returncode, 0, msg=f"ci_probe failed:\nstdout={ci_res.stdout}\nstderr={ci_res.stderr}")
                    self.assertEqual(seen["mcp_models"], ["model-example"])

                    dod_res = subprocess.run(["bash", str(ROOT / "scripts/dod_gate.sh")], capture_output=True, text=True, env=env)
                    self.assertEqual(dod_res.returncode, 0, msg=f"dod_gate failed:\nstdout={dod_res.stdout}\nstderr={dod_res.stderr}")
                    self.assertEqual(len(seen["chat_models"]), 5)
                    self.assertTrue(all(m == "model-example" for m in seen["chat_models"]))
                    self.assertTrue(all(h == "Bearer dummy-client-api-key" for h in seen["auth_headers"]))
            finally:
                srv.shutdown()


if __name__ == "__main__":
    unittest.main()
