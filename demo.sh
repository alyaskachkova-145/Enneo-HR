#!/bin/bash
# Enneo HR Ops — hackathon demo walkthrough.
# Simulates the Slack-first flow end to end against the running local server.
# Run `npm start` in another terminal first.

set -e
BASE="http://localhost:3000"
jq_or_cat() { command -v jq >/dev/null 2>&1 && jq . || cat; }

echo "== 1. Alina requests a holiday via /holiday (Slack slash command simulation) =="
RESP=$(curl -s -X POST "$BASE/slack/commands/holiday" \
  -H "Content-Type: application/json" \
  -d '{"slack_user_id":"U_ALINA_DEMO","start_date":"2026-08-10","end_date":"2026-08-14","reason":"summer trip"}')
echo "$RESP" | python3 -m json.tool
REQ_ID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['request']['id'])")
echo
echo "-> Notice the [SLACK -> @Kyung] / [SLACK -> @Richard] lines printed in the server log:"
echo "   that's the approval notification that would be a real Slack DM once the app is connected."
echo

read -p "Press enter to have Kyung approve the request..." _

echo "== 2. Kyung approves it (simulated one-click approve button) =="
curl -s -X POST "$BASE/slack/actions/$REQ_ID/approve" \
  -H "Content-Type: application/json" \
  -d '{"approver_slack_user_id":"U_KYUNG_DEMO"}' | python3 -m json.tool
echo

read -p "Press enter to view the team calendar..." _

echo "== 3. Team calendar shows the approved holiday + DE/BY public holidays =="
curl -s "$BASE/calendar?from=2026-08-01&to=2026-08-31" | python3 -m json.tool
echo

read -p "Press enter to generate a simple report..." _

echo "== 4. Monthly report (per-employee business days off) =="
curl -s "$BASE/report?year=2026&month=8" | python3 -m json.tool
echo
echo "CSV variant:"
curl -s "$BASE/report?year=2026&month=8&format=csv"
echo
echo
echo "== Bonus: weekly Slack digest of who's out / who's back =="
curl -s "$BASE/digest/weekly" | python3 -m json.tool
