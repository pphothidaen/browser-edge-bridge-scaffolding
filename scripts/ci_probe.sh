#!/usr/bin/env bash
set -euo pipefail

export PATH="$PATH:$HOME/.local/bin"

BRIDGE_BASE_URL="${BRIDGE_BASE_URL:-https://bridge.example.workers.dev}"
STATUS_URL="${STATUS_URL:-${BRIDGE_BASE_URL}/status}"
MCP_URL="${MCP_URL:-${BRIDGE_BASE_URL}/mcp}"
BRIDGE_MODEL="${BRIDGE_MODEL:-model-example}"
: "${BRIDGE_API_KEY:?BRIDGE_API_KEY must be set for production probes}"
API_KEY="${BRIDGE_API_KEY}"
LATENCY_MAX_SEC=8

echo "=== 1. Testing Hermes MCP connection (must see Connected + >=3 tools) ==="
mcp_output=$(hermes mcp test browser-edge-bridge 2>&1)
echo "${mcp_output}"

if ! echo "${mcp_output}" | grep -qi "Connected"; then
  echo "FAIL: 'Connected' not found in hermes mcp test output" >&2
  exit 1
fi

if ! echo "${mcp_output}" | grep -qiE "Tools discovered:[[:space:]]*([3-9]|[1-9][0-9]+)|([3-9]|[1-9][0-9]+)[[:space:]]+tools"; then
  echo "FAIL: expected at least 3 discovered tools in hermes mcp test output" >&2
  exit 1
fi
echo "PASS: Hermes MCP test connected and discovered >=3 tools."
echo

echo "=== 2 & 3. Calling bridge_chat & checking warm latency < 8s ==="
bridge_chat() {
  local prompt="$1"
  local model="$2"
  curl -f -s -S -X POST "${MCP_URL}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"bridge_chat\",\"arguments\":{\"prompt\":\"${prompt}\",\"model\":\"${model}\"}}}"
}

prompt="${PROBE_PROMPT:-ตอบสั้นว่าสถานะเป็นอะไร}"
model="${BRIDGE_MODEL}"

if command -v python3 >/dev/null 2>&1; then
  start_time=$(python3 -c 'import time; print(time.time())')
  chat_output=$(bridge_chat "${prompt}" "${model}")
  end_time=$(python3 -c 'import time; print(time.time())')
  duration=$(awk -v s="${start_time}" -v e="${end_time}" 'BEGIN { printf "%.2f", e - s }')
else
  start_time=$(date +%s)
  chat_output=$(bridge_chat "${prompt}" "${model}")
  end_time=$(date +%s)
  duration=$((end_time - start_time))
fi

echo "Response: ${chat_output}"
echo "Latency: ${duration}s"

if [ -z "${chat_output}" ]; then
  echo "FAIL: Empty response from bridge_chat" >&2
  exit 1
fi

if ! awk -v d="${duration}" -v max="${LATENCY_MAX_SEC}" 'BEGIN { exit !(d < max) }'; then
  echo "FAIL: Warm latency ${duration}s >= ${LATENCY_MAX_SEC}s" >&2
  exit 1
fi
echo "PASS: Warm latency ${duration}s < ${LATENCY_MAX_SEC}s."
echo

echo "=== 4. Checking CONNECTED status via curl to ${STATUS_URL} ==="
status_output=$(curl -f -s -S "${STATUS_URL}")
echo "Status: ${status_output}"

if ! echo "${status_output}" | grep -qiE '"extension"[[:space:]]*:[[:space:]]*"connected"'; then
  echo "FAIL: Extension status is not CONNECTED" >&2
  exit 1
fi
echo "PASS: Extension status is CONNECTED."
echo

echo "=== 5. Checking for mock or canned response ==="
if echo "${chat_output}" | grep -qiE 'mock|canned'; then
  echo "FAIL: Mock response detected in bridge_chat output" >&2
  exit 1
fi

if echo "${status_output}" | grep -qiE 'mock|canned'; then
  echo "FAIL: Mock response detected in status output" >&2
  exit 1
fi
echo "PASS: No mock or canned response detected."
echo

echo "=== All checks passed successfully ==="
exit 0
