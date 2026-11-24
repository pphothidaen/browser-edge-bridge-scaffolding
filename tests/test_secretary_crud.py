"""TDD test suite for Secretary Brain CRUD verification operations (KBN-001).

Acceptance Criteria:
- test_create_path_verification: Test CREATE with correct path verification (not failing on skill-reused paths)
- test_read_returns_content: Test READ returns expected content
- test_update_modifies_target: Test UPDATE modifies correct target file
- test_delete_removes_file: Test DELETE removes correct file
- test_verify_uses_original_request_for_path: Test verify_execution_result uses plan['goal'] as original_request (KBN-002)
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Ensure browser-edge-bridge is in sys.path
BRIDGE_DIR = Path(__file__).resolve().parent.parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import secretary


class TestSecretaryCrud(unittest.TestCase):
    """Test Secretary CRUD path verification and workflows with full standard unittest compatibility."""

    def setUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._temp_dir.name)
        self.skills_dir = self.tmp_path / "skills"
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self._orig_skills_dir = getattr(secretary, "SKILLS_DIR", None)
        secretary.SKILLS_DIR = self.skills_dir

    def tearDown(self):
        if self._orig_skills_dir is not None:
            secretary.SKILLS_DIR = self._orig_skills_dir
        self._temp_dir.cleanup()

    def test_create_path_verification(self):
        """Test CREATE with path-aware verification when skill reuse provides old action path."""
        new_file = self.tmp_path / "new_created_file.txt"
        old_skill_path = self.tmp_path / "old_skill_file.txt"

        new_file.write_text("hello created world")
        self.assertFalse(old_skill_path.exists(), "Old skill file should not exist")

        user_request = f"create file {new_file} with content hello created world"
        plan = {
            "goal": user_request,
            "plan": [
                {
                    "step": 1,
                    "action": f"create file {old_skill_path} with content hello created world",
                    "command_hint": f"echo 'hello created world' > '{new_file}'",
                    "expected_outcome": "File created",
                    "is_file_operation": True,
                }
            ],
        }
        exec_result = {
            "status": "success",
            "completed_steps": [
                {
                    "step": 1,
                    "action": f"create file {old_skill_path} with content hello created world",
                    "command": f"echo 'hello created world' > '{new_file}'",
                    "success": True,
                    "is_file_operation": True,
                }
            ],
        }

        # 1. Direct path extraction must prefer original_request over skill action
        extracted = secretary._extract_file_path_from_action(
            f"create file {old_skill_path}",
            str(self.tmp_path),
            original_request=user_request,
        )
        self.assertEqual(extracted, str(new_file), f"Expected {new_file}, got {extracted}")

        # 2. verify_execution_result must verify new_file exists (and pass)
        verif = secretary.verify_execution_result(plan, exec_result, cwd=str(self.tmp_path))
        self.assertTrue(verif["verified"], f"Verification failed: {verif['failures']}")
        self.assertTrue(
            any(str(new_file) in note for detail in verif["details"] for note in detail.get("notes", []))
        )

    def test_read_returns_content(self):
        """Test READ returns expected content for an existing file."""
        target_file = self.tmp_path / "read_target.txt"
        expected_content = "Secretary READ verification content 12345"
        target_file.write_text(expected_content)

        user_request = f"read file {target_file}"

        # should_consult should not trigger consultation for reading a file
        self.assertFalse(secretary.should_consult(user_request))

        # run_secrets_workflow should execute and return content
        result = secretary.run_secrets_workflow(user_request, cwd=str(self.tmp_path))
        self.assertEqual(result["status"], "success", f"Workflow failed: {result.get('error')}")
        self.assertTrue(result["verification"]["verified"])

        # Execution output should contain the file content
        completed_steps = result["execution"]["completed_steps"]
        self.assertGreater(len(completed_steps), 0)
        step_output = completed_steps[0].get("output", "")
        self.assertIn(expected_content, step_output)

    def test_update_modifies_target(self):
        """Test UPDATE modifies the correct target file and verifies changes."""
        target_file = self.tmp_path / "update_target.txt"
        target_file.write_text("initial content before update")

        old_file = self.tmp_path / "old_reused_update.txt"
        user_request = f"update file {target_file} to updated content 999"

        # 1. Path extraction test with reused action string
        extracted = secretary._extract_file_path_from_action(
            f"update file {old_file} to updated content 999",
            str(self.tmp_path),
            original_request=user_request,
        )
        self.assertEqual(extracted, str(target_file))

        # 2. End-to-end workflow execution
        result = secretary.run_secrets_workflow(user_request, cwd=str(self.tmp_path))
        self.assertEqual(result["status"], "success", f"Workflow failed: {result.get('error')}")
        self.assertTrue(result["verification"]["verified"])
        self.assertEqual(target_file.read_text().strip(), "updated content 999")

    def test_delete_removes_file(self):
        """Test DELETE removes the target file and verifies deletion."""
        target_file = self.tmp_path / "delete_target.txt"
        target_file.write_text("file to be deleted")
        self.assertTrue(target_file.exists())

        old_file = self.tmp_path / "old_reused_delete.txt"
        old_file.write_text("this old file should NOT be deleted")

        user_request = f"delete file {target_file}"

        # 1. Path extraction test with reused action string
        extracted = secretary._extract_file_path_from_action(
            f"delete file {old_file}",
            str(self.tmp_path),
            original_request=user_request,
        )
        self.assertEqual(extracted, str(target_file))

        # 2. End-to-end workflow execution
        result = secretary.run_secrets_workflow(user_request, cwd=str(self.tmp_path))
        self.assertEqual(result["status"], "success", f"Workflow failed: {result.get('error')}")
        self.assertTrue(result["verification"]["verified"])
        self.assertFalse(target_file.exists())
        self.assertTrue(old_file.exists())

    def test_verify_uses_original_request_for_path(self):
        """Test verify_execution_result uses plan['goal'] as original_request for path extraction (KBN-002)."""
        target_file = self.tmp_path / "actual_requested_file.txt"
        target_file.write_text("actual file content")
        stale_skill_file = self.tmp_path / "stale_skill_file.txt"

        plan = {
            "goal": f"create file {target_file} with content actual file content",
            "plan": [
                {
                    "step_num": 1,
                    "action": f"create file {stale_skill_file} with content actual file content",
                    "is_file_operation": True,
                }
            ],
        }
        exec_result = {
            "status": "success",
            "completed_steps": [
                {
                    "step_num": 1,
                    "action": f"create file {stale_skill_file} with content actual file content",
                    "success": True,
                    "is_file_operation": True,
                }
            ],
        }

        verif = secretary.verify_execution_result(plan, exec_result, cwd=str(self.tmp_path))
        self.assertTrue(verif["verified"])
        self.assertFalse(stale_skill_file.exists())
        self.assertTrue(target_file.exists())


if __name__ == "__main__":
    unittest.main()
