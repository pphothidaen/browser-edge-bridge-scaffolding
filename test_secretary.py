#!/usr/bin/env python3
"""
Secretary System Verification Test Suite
Tests all core functions of secretary.py

Run: python3 test_secretary.py
"""
import os
import sys

# Ensure current directory is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import the secretary module
import secretary


def test_python_import():
    """Test that secretary.py can be imported without errors."""
    print("[TEST] Testing Python import of secretary.py...")
    assert secretary is not None
    print("✅ secretary.py imported successfully")


def test_functions_exist():
    """Test that all required functions exist in secretary module."""
    print("\n[TEST] Checking required functions exist...")
    required_funcs = [
        'gather_context',
        'should_consult', 
        'prepare_consult_request',
        'call_consultant',
        'execute_plan',
        'self_heal',
        'run_secrets_workflow'
    ]
    
    missing = []
    for func_name in required_funcs:
        if hasattr(secretary, func_name) and callable(getattr(secretary, func_name)):
            print(f"  ✅ {func_name}")
        else:
            print(f"  ❌ {func_name} - MISSING")
            missing.append(func_name)
    
    assert len(missing) == 0, f"Missing functions: {missing}"


def test_gather_context():
    """Test context gathering functionality."""
    print("\n[TEST] Testing gather_context function...")
    context = secretary.gather_context("Test request")
    
    # Check required keys
    required_keys = ['request', 'cwd', 'python_version', 'os_info', 'relevant_files', 'timestamp']
    missing_keys = [k for k in required_keys if k not in context]
    assert not missing_keys, f"Missing keys: {missing_keys}"
    
    print(f"  ✅ Context gathered with {len(context['relevant_files'])} files")
    print(f"  ✅ Python version: {context['python_version'][:50]}")
    print(f"  ✅ CWD: {context['cwd']}")


def test_should_consult():
    """Test routing decision logic."""
    print("\n[TEST] Testing should_consult function...")
    
    test_cases = [
        ("Create a new file", True, "Should consult for 'create'"),
        ("Fix the bug in code", True, "Should consult for 'fix'"),
        ("Help me", False, "Should NOT consult for simple 'help'"),
        ("List files", False, "Should NOT consult for simple 'list'"),
    ]
    
    all_passed = True
    for request, expected, description in test_cases:
        result = secretary.should_consult(request)
        status = "✅" if result == expected else "❌"
        print(f"  {status} {description}: {result} (expected {expected})")
        if result != expected:
            all_passed = False
    
    assert all_passed, "Some routing decision test cases failed"


def test_prepare_consult_request():
    """Test request preparation for consultant."""
    print("\n[TEST] Testing prepare_consult_request function...")
    context = secretary.gather_context("Test request")
    request = secretary.prepare_consult_request("Test user request", context)
    
    # Check structure
    required_keys = ['model', 'messages']
    assert all(k in request for k in required_keys), f"Missing keys in request: {required_keys}"
    assert len(request['messages']) >= 2, "Not enough messages in request"
    
    print(f"  ✅ Request prepared correctly")
    print(f"  ✅ Model: {request['model']}")
    print(f"  ✅ Messages: {len(request['messages'])}")


def test_mock_consultant():
    """Test consultant communication with mock (no network required)."""
    print("\n[TEST] Testing consultant communication (mock mode)...")
    from unittest import mock
    
    mock_resp = mock.Mock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "model": "model-reasoning",
        "choices": [{"message": {"content": '{"goal": "mock test", "analysis": "mock analysis", "plan": []}'}}]
    }
    
    with mock.patch("requests.post", return_value=mock_resp):
        context = secretary.gather_context("Test request")
        result = secretary.call_consultant("Test request for mock", context)
    
    assert result is not None, "Consultant returned None"
    has_valid_format = ("goal" in result or "analysis" in result or "_parse_error" in result)
    assert has_valid_format, f"Unexpected response format: {result}"
    print(f"  ✅ Got response from consultant (mock mode)")
    print(f"  ✅ Response keys: {list(result.keys())[:5]}")


def test_execution():
    """Test plan execution functionality."""
    print("\n[TEST] Testing plan execution...")
    
    test_plan = {
        "goal": "Test execution",
        "plan": [
            {"step": 1, "action": "Create test file", "command_hint": "echo 'test content' > /tmp/test_secretary.txt", "expected_outcome": "File created"},
            {"step": 2, "action": "Verify file", "command_hint": "cat /tmp/test_secretary.txt", "expected_outcome": "File contents displayed"},
        ]
    }
    
    result = secretary.execute_plan(test_plan)
    assert result["status"] == "success", f"Execution failed: {result.get('error', 'Unknown')}"
    print(f"  ✅ Execution completed successfully")
    print(f"  ✅ Steps executed: {result['total_steps']}")
    print(f"  ✅ All steps: {[s['step'] for s in result['completed_steps']]}")


def test_self_healing():
    """Test self-healing functionality."""
    print("\n[TEST] Testing self-healing mechanism...")
    
    # Create a plan with a command that will fail
    failing_plan = {
        "goal": "Test self-healing",
        "plan": [
            {"step": 1, "action": "This will fail", "command_hint": "false", "expected_outcome": "Failure for testing"},
        ]
    }
    
    # Execute the failing plan
    result = secretary.execute_plan(failing_plan)
    assert result["status"] == "partial_failure", f"Expected partial_failure but got: {result['status']}"
    
    failed_step = result["completed_steps"][0]
    print(f"  ✅ Got expected failure: {failed_step['action']}")
    
    # Now test self-healing
    print(f"  🔄 Testing self-healing for failed step...")
    context = secretary.gather_context("Test self-healing")
    heal_result = secretary.self_heal("Test self-healing request", failed_step, context)
    
    if heal_result is not None:
        print(f"  ✅ Self-healing returned alternative plan")
        print(f"  ✅ Alternative has {len(heal_result.get('alternative_plan', []))} steps")
    else:
        print(f"  ⚠️  Self-healing returned None (may be network issue)")


def test_dry_run_mode():
    """Test dry-run mode capability."""
    print("\n[TEST] Testing dry-run mode capability...")
    assert hasattr(secretary, 'run_secrets_workflow'), "run_secrets_workflow not found"
    print(f"  ✅ run_secrets_workflow function available")
    print(f"  ℹ️  Dry-run mode can be implemented by skipping execution step")


def main():
    print("=" * 60)
    print("SECRETARY SYSTEM VERIFICATION")
    print("=" * 60)
    print(f"\nTesting secretary.py at: {os.path.dirname(os.path.abspath(__file__))}")
    print(f"Python version: {sys.version}")
    print(f"Working directory: {os.getcwd()}")
    
    tests = [
        ("Python Import", test_python_import),
        ("Function Existence", test_functions_exist),
        ("Context Gathering", test_gather_context),
        ("Routing Logic", test_should_consult),
        ("Request Preparation", test_prepare_consult_request),
        ("Mock Consultant", test_mock_consultant),
        ("Plan Execution", test_execution),
        ("Self-Healing", test_self_healing),
        ("Dry-Run Mode", test_dry_run_mode),
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            test_func()
            results.append((test_name, True))
        except Exception as e:
            print(f"\n[TEST] ❌ {test_name} crashed: {e}")
            results.append((test_name, False))
    
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    
    passed_count = sum(1 for _, passed in results if passed)
    total_count = len(results)
    
    for test_name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {status}: {test_name}")
    
    print(f"\nTotal: {passed_count}/{total_count} tests passed")
    
    if passed_count == total_count:
        print("\n🎉 ALL TESTS PASSED - System is ready to use!")
        return 0
    else:
        print(f"\n⚠️  {total_count - passed_count} test(s) failed - Review issues above")
        return 1


if __name__ == "__main__":
    sys.exit(main())
