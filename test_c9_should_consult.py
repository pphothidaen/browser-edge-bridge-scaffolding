#!/usr/bin/env python3
"""Test should_consult after fix (C9 verification)."""
import unittest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secretary


class TestShouldConsult(unittest.TestCase):
    def test_should_consult_cases(self):
        tests = [
            ("สร้างไฟล์ hello.txt", False, "CREATE"),
            ("ลบไฟล์ data.txt", False, "DELETE"),
            ("แก้ไขไฟล์ config.json เป็นใหม่", False, "UPDATE"),
            ("ออกแบบสถาปัตยกรรมระบบใหม่", True, "Design"),
            ("วางแผน deploy ระบบ", True, "Planning"),
            ("วิธีที่ดีที่สุดในการ optimize query", True, "Advisory"),
            ("build new feature", True, "Build"),
            ("debug production issue", True, "Debug"),
        ]
        for req, expected, desc in tests:
            with self.subTest(desc=desc, req=req):
                self.assertEqual(secretary.should_consult(req), expected)


if __name__ == "__main__":
    unittest.main()
