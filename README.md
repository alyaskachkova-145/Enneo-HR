# Enneo HR Ops — hackathon MVP

Replaces the manual Notion holiday tracker with request/approval flow,
public holiday awareness (DE + BY + HU), a team calendar, a weekly digest,
and a simple report. Backed by Postgres on Supabase (project: **Enneo HR
Ops**, `mvzxteihazoaemcntgoe`, eu-central-1).

Employee roster and 2026 vacation history are imported from the real Notion
"☎️ Team Directory" and "🌴 Vacation list" databases — 15 employees, real
approver chain (org reporting lines), 74 historical/planned 2026 requests.

## Scope for this demo

Real Slack app connection is deferred ("connectors later"), so `slack.js` is
a mock layer: every notification that would be a Slack DM/channel post is
logged to the server console **and** returned in the API response, formatted
exactly like the real message would look. Swapping in `@slack/bolt` later
only touches `slack.js` — route logic in `server.js` doesn't change.

Out of scope per the hackathon brief: DATEV export format, historical data
migration (beyond the one-time Notion import already done).

A browser dashboard is included (`public/`), styled with the Enneo design
system (`.claude/skills/enneo-design`) — Inter, paper-white, purple primary.
It's a read + approve/reject overview, not a replacement for the Slack-first
request flow.

## Setup

```bash
npm install
npm start   # http://localhost:3000
```

Open `http://localhost:3000` for the dashboard (redirects to `/login` if not
signed in), or drive the API directly (see below / `demo.sh`, which doesn't
need a login since it hits the Slack-simulation endpoints directly).

`.env` already contains the Supabase URL + service role key (gitignored —
don't commit it).

## Roles (multi-role) & approver routing

Roles are additive flags, so one person can hold several at once:
- `is_approver` — can be assigned as someone's approver and can approve/reject
- `is_admin` — can configure teams and roles (see Admin below)
- everyone is an employee at the base level

Richard and Kyung are **both admin + approver**; Dmitry, Chris, and Alina are
approvers; everyone else is a plain employee.

Every employee has an `approver_id` (their team lead / manager). That is who
gets notified and who alone can approve/reject that employee's requests — not
just anyone with the approver flag. Kyung and Richard (co-founders) are each
other's approver so nobody is left without one.

## Teams & Admin

Admins get an **Admin** section (hidden for everyone else) to configure the org:
- **Teams** — create a team with a lead (an approver). Teams are seeded from the
  existing reporting chain (one per lead). Assigning an employee to a team sets
  their `approver_id` to that team's lead, so approval routing follows team
  structure.
- **People & roles** — per-employee toggles for Admin / Approver and a team
  dropdown; changes take effect immediately.
- Add employee / add country / edit holiday source are admin-only.

`teams(id, name, lead_id)` + `employees.team_id`; admin mutations are guarded
server-side by a `requireAdmin` check, not just hidden in the UI.

## Browser dashboard

Login is per-employee, backed by the `employees` table (`password` column —
plaintext `enneo` for every seeded account, demo-only, not shown on the login
page). What you see depends on your role:
- **Approver** — "Pending Approvals" shows only requests from people who report to you, with working Approve/Reject
- **Employee** — sees the same dashboard read-only; your own pending requests show a status badge instead of action buttons

Header has a **🌴 Request day off** button (any user) — opens a modal that
submits a request as the logged-in user; it tells you which approver it will
go to. Approvers see the requests they need to act on the moment they log in
(the "Approvals" nav badge shows *their* actionable count). Approvers can
approve/reject from **both** the Pending Approvals panel and the Requests &
Reports table (action buttons appear only on pending requests they are the
assigned approver for).

The layout is deliberately minimal — only what serves the goal. Three KPIs
(Team Members, Pending Approvals, Out This Week), then five sections reachable
from the sidebar: **Approvals** (pending requests scoped to you), **Calendar**
(month grid — see below), **Holiday Alerts** (upcoming public holidays across
all countries, each highlighting who's unavailable by location), **Requests &
Reports** (request history + a period selector — month/quarter/year — that
downloads a CSV), and **Team** (employee directory + "Add employee";
countries with each country's holiday-source URL + "Edit source" / "Add
country"). No vanity charts.

## Team Calendar (month grid)

A full month grid showing, per day: **approved time off** as
consistently-coloured bars per person (a multi-day vacation reads as one colour
block, so overlapping vacations are obvious at a glance) and **public holidays**
as flagged chips on the day. Weekends are shaded, today is ringed, holiday days
are tinted. Cells with many people off collapse to "+N more". A legend maps
colours to people for the visible month and calls out how many days have 2+
people off. Prev / next / Today navigation moves between months. Backed by the
existing `GET /calendar?from=&to=`.

## Public holiday awareness (`GET /api/holiday-awareness`)

Returns upcoming public holidays (default next 90 days) across **all** seeded
countries, each with the list of employees located in that country who will
therefore be unavailable. This is what will drive the Slack holiday
notification once Slack is connected (previewed via `slack.js` today).

## Holiday sources per country

Each country carries a `holiday_source_url` — the authoritative public-holiday
resource for that location, editable in the UI:
- **Belarus → https://calendar.by/** (pinned per requirement)
- **Germany → https://www.feiertage.de/**
- **Hungary → https://publicholidays.hu/**

New countries can set their own source when added. These are where a future
job would scrape/sync each country's holidays from.

## Slack — deferred

Slack is **connected later**. Everything that will post to Slack runs through
`slack.js` today (logs the message + returns it in the API response): the two
flows that matter are (1) a vacation request notifying the employee's assigned
approver, and (2) the public-holiday awareness digest. Swapping in
`@slack/bolt` later touches only `slack.js`.

## Data model

- `countries` — code + name, seeded DE/BY/HU, extensible via the UI or `POST /api/countries`
- `employees` — real roster from Notion; `country` FKs to `countries`, `approver_id` self-references `employees`, `password` for dashboard login
- `public_holidays` — 2026 DE (nationwide), BY, and HU holidays seeded
- `holiday_requests` — pending/approved/rejected, tied to employee + approver; 74 rows imported from the 2026 Notion vacation list

## Endpoints (simulated Slack surface)

| Endpoint | Simulates |
|---|---|
| `POST /slack/commands/holiday` | `/holiday <start> <end> [reason]` slash command |
| `POST /slack/actions/:id/approve` | clicking "Approve" on the DM (only the assigned approver can act) |
| `POST /slack/actions/:id/reject` | clicking "Reject" on the DM (same restriction) |
| `GET /calendar?from=&to=` | team calendar view |
| `GET /digest/weekly` | weekly "who's out / who's back" digest |
| `GET /report?year=&month=&format=json\|csv` | simple monthly report |

## Dashboard-only endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/dashboard?range=month\|quarter\|year` | stats, chart, donut, holidays, recent requests in one call |
| `GET /api/employees` | employee directory (name, country, role, approver) |
| `POST /api/employees` | add an employee (name, email, password, country, role, approver_id) |
| `GET /api/countries` | country list |
| `POST /api/countries` | add a country (code, name) |
| `GET /api/requests?status=&limit=&scope=` | request list; `scope=my-approvals` (assigned to me) or `scope=mine` (my own) |

Requesting a holiday:
- blocks if it overlaps the employee's own pending/approved request
- warns (non-blocking) if the range includes a public holiday for their country
- blocks if the employee has no `approver_id` assigned

## Demo script

```bash
./demo.sh
```

Walks through: request → approval notification → team calendar → report →
weekly digest, pausing between steps so you can narrate. Uses Alina/Kyung's
seeded Slack IDs — still valid after the Notion import.

## Next steps beyond the hackathon

- Wire `slack.js` to `@slack/bolt` (Socket Mode, no public URL needed) using
  a real Slack app + bot token
- DATEV-compliant export format
- Real auth (hashed passwords, session expiry) — current login is demo-only
