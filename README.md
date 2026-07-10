# Enneo HR Ops — hackathon MVP

Replaces the manual Notion holiday tracker with request/approval flow,
public holiday awareness (DE + BY), a team calendar, a weekly digest, and a
simple report. Backed by Postgres on Supabase (project: **Enneo HR Ops**,
`mvzxteihazoaemcntgoe`, eu-central-1).

## Scope for this demo

Real Slack app connection is deferred ("connectors later"), so `slack.js` is
a mock layer: every notification that would be a Slack DM/channel post is
logged to the server console **and** returned in the API response, formatted
exactly like the real message would look. Swapping in `@slack/bolt` later
only touches `slack.js` — route logic in `server.js` doesn't change.

Out of scope per the hackathon brief: DATEV export format, historical data
migration, browser UI.

## Setup

```bash
npm install
npm start   # http://localhost:3000
```

`.env` already contains the Supabase URL + service role key (gitignored —
don't commit it).

## Data model

- `employees` — Kyung & Richard seeded as approvers, Alina as a demo employee (BY)
- `public_holidays` — 2026 DE (nationwide) + BY holidays seeded
- `holiday_requests` — pending/approved/rejected, tied to employee + optional approver

## Endpoints (simulated Slack surface)

| Endpoint | Simulates |
|---|---|
| `POST /slack/commands/holiday` | `/holiday <start> <end> [reason]` slash command |
| `POST /slack/actions/:id/approve` | clicking "Approve" on the DM |
| `POST /slack/actions/:id/reject` | clicking "Reject" on the DM |
| `GET /calendar?from=&to=` | team calendar view |
| `GET /digest/weekly` | weekly "who's out / who's back" digest |
| `GET /report?year=&month=&format=json\|csv` | simple monthly report |

Requesting a holiday:
- blocks if it overlaps the employee's own pending/approved request
- warns (non-blocking) if the range includes a public holiday for their country

## Demo script

```bash
./demo.sh
```

Walks through: request → approval notification → team calendar → report →
weekly digest, pausing between steps so you can narrate.

## Next steps beyond the hackathon

- Wire `slack.js` to `@slack/bolt` (Socket Mode, no public URL needed) using
  a real Slack app + bot token
- DATEV-compliant export format
- Browser UI for overview/history
