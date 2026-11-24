#!/usr/bin/env bash
set -euo pipefail

# Configuration
BRIDGE_BASE_URL="${BRIDGE_BASE_URL:-https://bridge.example.workers.dev}"
CHAT_ENDPOINT="${BRIDGE_BASE_URL}/v1/chat/completions"
STATUS_ENDPOINT="${BRIDGE_BASE_URL}/status"
BRIDGE_MODEL="${BRIDGE_MODEL:-model-example}"
STATUS_PROBES="${STATUS_PROBES:-100}"
: "${BRIDGE_API_KEY:?BRIDGE_API_KEY must be set for DoD chat probes}"

LATENCY_MAX_SEC=8
CONNECTED_MIN_RATE=99
MOCK_REGEX='mock|canned|simulated|placeholder'

FAILED_CHECKS=0
current_response_file=""
cleanup_tmp() {
  if [ -n "${current_response_file}" ] && [ -f "${current_response_file}" ]; then
    rm -f "${current_response_file}"
  fi
}
trap cleanup_tmp EXIT

echo "=== Phase 6 DoD Gate Verification ==="
echo "Target Base URL: ${BRIDGE_BASE_URL}"
echo

# ---------------------------------------------------------
# Criterion 1: Warm latency < 8s (median of 5 chat requests)
# ---------------------------------------------------------
echo "Checking Criterion 1: Warm latency < ${LATENCY_MAX_SEC}s (5 requests)..."
latencies=()
chat_responses=()
chat_probe_failures=0

for i in {1..5}; do
  response_file=$(mktemp)
  current_response_file="${response_file}"
  # Measure time taken in seconds (using curl's %{time_total})
  if ! duration=$(curl -f -s -S -o "${response_file}" -w "%{time_total}" -X POST "${CHAT_ENDPOINT}" \
    -H "Authorization: Bearer ${BRIDGE_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${BRIDGE_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"); then
    duration="999"
    chat_probe_failures=$((chat_probe_failures + 1))
    echo "  Probe $i: request failed" >&2
  fi
  
  resp_body=$(cat "${response_file}")
  chat_responses+=("${resp_body}")
  rm -f "${response_file}"
  current_response_file=""

  latencies+=("${duration}")
  echo "  Probe $i: ${duration}s"
done

# Sort latencies numerically to calculate median (index 2 in 0-indexed 5 items)
# Use a portable read loop so the script works on stock macOS Bash 3.2 as well as Linux.
sorted_latencies=()
while IFS= read -r latency_value; do
  sorted_latencies+=("${latency_value}")
done < <(printf '%s\n' "${latencies[@]}" | sort -n)
median_latency="${sorted_latencies[2]}"
echo "Median Warm Latency: ${median_latency}s"

if [ "${chat_probe_failures}" -eq 0 ] && awk -v median="${median_latency}" -v max="${LATENCY_MAX_SEC}" 'BEGIN { exit !(median < max) }'; then
  echo "  -> Criterion 1 Result: PASS"
else
  echo "  -> Criterion 1 Result: FAIL (failed probes: ${chat_probe_failures}, median: ${median_latency}s, threshold: < ${LATENCY_MAX_SEC}s)"
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
fi
echo

# ---------------------------------------------------------
# Criterion 2: CONNECTED >= 99% (STATUS_PROBES probes of /status)
# ---------------------------------------------------------
echo "Checking Criterion 2: Extension CONNECTED >= ${CONNECTED_MIN_RATE}% (${STATUS_PROBES} probes)..."
total_probes="${STATUS_PROBES}"
connected_count=0
status_probe_failures=0

for ((i=1; i<=total_probes; i++)); do
  if ! status_json=$(curl -f -s -S "${STATUS_ENDPOINT}"); then
    status_json='{}'
    status_probe_failures=$((status_probe_failures + 1))
    echo "  Probe $i: request failed" >&2
  fi
  # Check if status JSON indicates connected extension state
  if echo "${status_json}" | grep -qi '"extension"[[:space:]]*:[[:space:]]*"connected"'; then
    connected_count=$((connected_count + 1))
  elif echo "${status_json}" | grep -qi '"connected"[[:space:]]*:[[:space:]]*true'; then
    connected_count=$((connected_count + 1))
  fi
done

failure_count=$((total_probes - connected_count))
connected_rate=$(( (connected_count * 100) / total_probes ))
echo "Connected: ${connected_count}/${total_probes} (${connected_rate}%), Failures: ${failure_count}, Request failures: ${status_probe_failures}"

if [ "${connected_rate}" -ge "${CONNECTED_MIN_RATE}" ]; then
  echo "  -> Criterion 2 Result: PASS"
else
  echo "  -> Criterion 2 Result: FAIL (${connected_rate}% < ${CONNECTED_MIN_RATE}%)"
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
fi
echo

# ---------------------------------------------------------
# Criterion 3: 0 mock responses
# ---------------------------------------------------------
echo "Checking Criterion 3: 0 mock responses (pattern: '${MOCK_REGEX}')..."
mock_detected=0

for resp in "${chat_responses[@]}"; do
  if echo "${resp}" | grep -Eiq "${MOCK_REGEX}"; then
    mock_detected=$((mock_detected + 1))
    echo "  Found mock token match in response: ${resp}"
  fi
done

if [ "${mock_detected}" -eq 0 ]; then
  echo "  -> Criterion 3 Result: PASS (0 mock tokens found)"
else
  echo "  -> Criterion 3 Result: FAIL (${mock_detected} mock responses detected)"
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
fi
echo

# ---------------------------------------------------------
# Summary and Final Verdict
# ---------------------------------------------------------
echo "=== Phase 6 DoD Gate Summary ==="
echo "1. Warm Latency (Median): ${median_latency}s (Threshold: < ${LATENCY_MAX_SEC}s)"
echo "2. Extension Connected Rate: ${connected_rate}% (Failures: ${failure_count}/${total_probes}, Threshold: >= ${CONNECTED_MIN_RATE}%)"
echo "3. Mock Responses: ${mock_detected} (Threshold: 0)"
echo

if [ "${FAILED_CHECKS}" -eq 0 ]; then
  echo "OVERALL VERDICT: PASS"
  exit 0
else
  echo "OVERALL VERDICT: FAIL (${FAILED_CHECKS} check(s) failed)"
  exit 1
fi
