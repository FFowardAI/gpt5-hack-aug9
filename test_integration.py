#!/usr/bin/env python3
"""
Integration test for MCP -> generate_unit_tests pipeline.

This script verifies that the MCP server correctly invokes the generate_unit_tests.py
script via subprocess when the test_modification tool is called.

Usage:
    # With real API key (will generate actual tests):
    export OPENAI_API_KEY='your-key-here'
    python test_integration.py
    
    # With mock generator (no API key needed):
    python test_integration.py --mock
"""

import json
import sys
import os
import argparse
import shutil
from pathlib import Path

# Mock fastmcp to avoid import errors
sys.modules['fastmcp'] = type(sys)('fastmcp')
sys.modules['fastmcp'].FastMCP = lambda name: type('FastMCP', (), {
    'tool': lambda self, **kwargs: lambda func: func,
    'run': lambda self, **kwargs: None
})()

# Import the MCP server module
sys.path.insert(0, str(Path(__file__).parent / "mcp"))
from server import test_modification


def setup_mock_generator():
    """Replace real generator with mock for testing"""
    real = Path("TestGen/generate_unit_tests.py")
    mock = Path("TestGen/generate_unit_tests_mock.py")
    backup = Path("TestGen/generate_unit_tests.backup.py")
    
    if real.exists():
        shutil.copy(real, backup)
    if mock.exists():
        shutil.copy(mock, real)
        return backup
    return None


def restore_generator(backup_path):
    """Restore the real generator from backup"""
    if backup_path and backup_path.exists():
        real = Path("TestGen/generate_unit_tests.py")
        shutil.copy(backup_path, real)
        backup_path.unlink()


def test_integration(use_mock=False):
    """Test the complete MCP -> generate_unit_tests integration"""
    
    backup = None
    if use_mock:
        print("Using mock generator (no API key required)")
        backup = setup_mock_generator()
    else:
        if not os.environ.get("OPENAI_API_KEY"):
            print("⚠️  ERROR: OPENAI_API_KEY not set!")
            print("Either set the API key or use --mock flag")
            return False
    
    try:
        print("\n" + "="*60)
        print("Testing MCP Server Integration")
        print("="*60)
        
        # Test data
        test_cases = [
            {
                "name": "Authentication Feature",
                "user_message": "Add user authentication with login and logout",
                "modified_files": [
                    {
                        "path": "auth/login.py",
                        "diff": """--- a/auth/login.py
+++ b/auth/login.py
@@ -1,3 +1,8 @@
 def login(username, password):
-    pass
+    if not username or not password:
+        return {"success": False, "error": "Missing credentials"}
+    if username == "admin" and password == "secret":
+        return {"success": True, "token": "abc123"}
+    return {"success": False, "error": "Invalid credentials"}
"""
                    }
                ],
                "related_files": ["auth/session.py", "auth/middleware.py"]
            },
            {
                "name": "Shopping Cart",
                "user_message": "Implement shopping cart with add/remove items",
                "modified_files": [
                    {
                        "file": "cart/cart.py",  # Test alternate key name
                        "patch": """--- a/cart/cart.py
+++ b/cart/cart.py
@@ -0,0 +1,10 @@
+class Cart:
+    def __init__(self):
+        self.items = []
+    
+    def add_item(self, item):
+        self.items.append(item)
+    
+    def remove_item(self, item_id):
+        self.items = [i for i in self.items if i['id'] != item_id]
"""
                    }
                ],
                "related_files": []
            }
        ]
        
        all_passed = True
        
        for i, test_case in enumerate(test_cases, 1):
            print(f"\nTest Case {i}: {test_case['name']}")
            print("-" * 40)
            
            # Call the MCP function
            result = test_modification(
                user_message=test_case["user_message"],
                modified_files=test_case["modified_files"],
                related_files=test_case["related_files"]
            )
            
            # Verify result
            try:
                result_obj = json.loads(result)
                
                if result_obj.get("ok"):
                    tests = result_obj.get("tests", [])
                    print(f"✅ SUCCESS: Generated {len(tests)} tests")
                    
                    # Show first test as sample
                    if tests:
                        print(f"\nSample test output:")
                        print("-" * 20)
                        print(tests[0][:200] + "..." if len(tests[0]) > 200 else tests[0])
                else:
                    print(f"❌ FAILED: {result_obj.get('error')}")
                    all_passed = False
                    
            except json.JSONDecodeError as e:
                print(f"❌ FAILED: Invalid JSON response")
                print(f"   Error: {e}")
                print(f"   Response: {result[:200]}")
                all_passed = False
        
        print("\n" + "="*60)
        if all_passed:
            print("✅ All tests passed!")
        else:
            print("❌ Some tests failed")
        print("="*60)
        
        return all_passed
        
    finally:
        if backup:
            restore_generator(backup)
            print("\nRestored real generator")


def main():
    parser = argparse.ArgumentParser(description="Test MCP integration")
    parser.add_argument("--mock", action="store_true", 
                       help="Use mock generator instead of real GPT-5 API")
    args = parser.parse_args()
    
    success = test_integration(use_mock=args.mock)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
