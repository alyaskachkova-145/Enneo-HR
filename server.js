require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const { supabase } = require('./db');
const slack = require('./slack');
const { rangesOverlap, countBusinessDays, isoDate, toDate } = require('./dates');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

async function getEmployeeBySlackId(slackUserId) {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('slack_user_id', slackUserId)
    .single();
  if (error) throw error;
  return data;
}

async function getApprovers() {
  const { data, error } = await supabase.from('employees').select('*').eq('role', 'approver');
  if (error) throw error;
  return data;
}

async function getHolidaysForCountry(country) {
  const { data, error } = await supabase
    .from('public_holidays')
    .select('*')
    .eq('country', country);
  if (error) throw error;
  return data;
}

// --- Simulated Slack slash command: /holiday 2026-08-10 2026-08-14 [reason] ---
// Real Slack app is wired later; this endpoint accepts the same payload shape
// a Bolt slash-command handler would receive after parsing.
app.post('/slack/commands/holiday', async (req, res) => {
  try {
    const { slack_user_id, start_date, end_date, reason } = req.body;
    if (!slack_user_id || !start_date || !end_date) {
      return res.status(400).json({ error: 'slack_user_id, start_date, end_date are required' });
    }
    if (toDate(start_date) > toDate(end_date)) {
      return res.status(400).json({ error: 'start_date must be before end_date' });
    }

    const employee = await getEmployeeBySlackId(slack_user_id);
    if (!employee) return res.status(404).json({ error: 'Unknown Slack user' });

    // Overlap check against this employee's own existing pending/approved requests
    const { data: existing, error: existErr } = await supabase
      .from('holiday_requests')
      .select('*')
      .eq('employee_id', employee.id)
      .in('status', ['pending', 'approved']);
    if (existErr) throw existErr;

    const overlapping = existing.find((r) => rangesOverlap(start_date, end_date, r.start_date, r.end_date));
    if (overlapping) {
      return res.status(409).json({
        error: `Overlaps existing ${overlapping.status} request (${overlapping.start_date} → ${overlapping.end_date})`,
      });
    }

    // Public holiday conflict warning (informational, non-blocking)
    const holidays = await getHolidaysForCountry(employee.country);
    const holidaySet = new Set(holidays.map((h) => h.holiday_date));
    const touchedHolidays = holidays.filter(
      (h) => toDate(h.holiday_date) >= toDate(start_date) && toDate(h.holiday_date) <= toDate(end_date)
    );
    const conflictWarning = touchedHolidays.length
      ? `Range includes ${employee.country} public holiday(s): ${touchedHolidays.map((h) => `${h.name} (${h.holiday_date})`).join(', ')}`
      : null;

    const businessDays = countBusinessDays(start_date, end_date, holidaySet);

    const { data: inserted, error: insertErr } = await supabase
      .from('holiday_requests')
      .insert({
        id: randomUUID(),
        employee_id: employee.id,
        start_date,
        end_date,
        reason: reason || null,
        status: 'pending',
        conflict_warning: conflictWarning,
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    const approvers = await getApprovers();
    const notification = slack.notifyApprovers(approvers, inserted, employee);

    res.status(201).json({
      request: inserted,
      business_days: businessDays,
      conflict_warning: conflictWarning,
      slack_notification_preview: notification,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Simulated Slack interactive button: approve/reject ---
async function decide(req, res, status) {
  try {
    const { id } = req.params;
    const { approver_slack_user_id } = req.body;
    if (!approver_slack_user_id) {
      return res.status(400).json({ error: 'approver_slack_user_id is required' });
    }

    const approver = await getEmployeeBySlackId(approver_slack_user_id);
    if (!approver || approver.role !== 'approver') {
      return res.status(403).json({ error: 'Only Kyung or Richard can approve/reject requests' });
    }

    const { data: request, error: reqErr } = await supabase
      .from('holiday_requests')
      .select('*')
      .eq('id', id)
      .single();
    if (reqErr) throw reqErr;
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(409).json({ error: `Request already ${request.status}` });
    }

    const { data: updated, error: updErr } = await supabase
      .from('holiday_requests')
      .update({ status, approver_id: approver.id, decided_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    const { data: employee } = await supabase
      .from('employees')
      .select('*')
      .eq('id', request.employee_id)
      .single();

    const notification = slack.notifyDecision(updated, employee, approver);

    res.json({ request: updated, slack_notification_preview: notification });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

app.post('/slack/actions/:id/approve', (req, res) => decide(req, res, 'approved'));
app.post('/slack/actions/:id/reject', (req, res) => decide(req, res, 'rejected'));

// --- Team calendar: approved holidays + public holidays in a date range ---
app.get('/calendar', async (req, res) => {
  try {
    const from = req.query.from || isoDate(new Date());
    const to = req.query.to || isoDate(new Date(Date.now() + 90 * 86400000));

    const { data: requests, error: reqErr } = await supabase
      .from('holiday_requests')
      .select('*, employees!holiday_requests_employee_id_fkey(name, country)')
      .eq('status', 'approved')
      .lte('start_date', to)
      .gte('end_date', from);
    if (reqErr) throw reqErr;

    const { data: holidays, error: holErr } = await supabase
      .from('public_holidays')
      .select('*')
      .gte('holiday_date', from)
      .lte('holiday_date', to)
      .order('holiday_date');
    if (holErr) throw holErr;

    res.json({
      range: { from, to },
      team_holidays: requests.map((r) => ({
        employee: r.employees.name,
        country: r.employees.country,
        start_date: r.start_date,
        end_date: r.end_date,
      })),
      public_holidays: holidays,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Weekly Slack digest: who's out next week, who's back ---
app.get('/digest/weekly', async (req, res) => {
  try {
    const today = new Date();
    const dayOfWeek = today.getUTCDay();
    const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
    const nextMonday = new Date(today);
    nextMonday.setUTCDate(today.getUTCDate() + daysUntilMonday);
    const nextSunday = new Date(nextMonday);
    nextSunday.setUTCDate(nextMonday.getUTCDate() + 6);

    const from = isoDate(nextMonday);
    const to = isoDate(nextSunday);

    const { data: requests, error } = await supabase
      .from('holiday_requests')
      .select('*, employees!holiday_requests_employee_id_fkey(name)')
      .eq('status', 'approved')
      .lte('start_date', to)
      .gte('end_date', from);
    if (error) throw error;

    const outNextWeek = requests
      .filter((r) => r.start_date <= to && r.end_date >= from)
      .map((r) => ({ employee: r.employees, start_date: r.start_date, end_date: r.end_date }));

    const backNextWeek = requests
      .filter((r) => r.end_date >= from && r.end_date <= to)
      .map((r) => {
        const backDate = new Date(toDate(r.end_date));
        backDate.setUTCDate(backDate.getUTCDate() + 1);
        return { employee: r.employees, end_date_plus_one: isoDate(backDate) };
      });

    const message = slack.weeklyDigestMessage(outNextWeek, backNextWeek, `${from} → ${to}`);

    res.json({ range: { from, to }, out_next_week: outNextWeek, back_next_week: backNextWeek, slack_message_preview: message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Simple report: approved holiday days per employee for a month ---
app.get('/report', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getUTCMonth() + 1; // 1-12
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const { data: requests, error } = await supabase
      .from('holiday_requests')
      .select('*, employees!holiday_requests_employee_id_fkey(name, country)')
      .eq('status', 'approved')
      .lte('start_date', to)
      .gte('end_date', from);
    if (error) throw error;

    const { data: allHolidays, error: holErr } = await supabase.from('public_holidays').select('*');
    if (holErr) throw holErr;
    const holidaysByCountry = {};
    for (const h of allHolidays) {
      holidaysByCountry[h.country] = holidaysByCountry[h.country] || new Set();
      holidaysByCountry[h.country].add(h.holiday_date);
    }

    const perEmployee = {};
    for (const r of requests) {
      const clampedStart = r.start_date < from ? from : r.start_date;
      const clampedEnd = r.end_date > to ? to : r.end_date;
      const holidaySet = holidaysByCountry[r.employees.country] || new Set();
      const days = countBusinessDays(clampedStart, clampedEnd, holidaySet);

      const key = r.employees.name;
      perEmployee[key] = perEmployee[key] || { employee: key, country: r.employees.country, business_days_off: 0, requests: [] };
      perEmployee[key].business_days_off += days;
      perEmployee[key].requests.push({ start_date: r.start_date, end_date: r.end_date, business_days: days });
    }

    const rows = Object.values(perEmployee);
    const format = req.query.format || 'json';

    if (format === 'csv') {
      const header = 'employee,country,business_days_off\n';
      const csv = header + rows.map((r) => `${r.employee},${r.country},${r.business_days_off}`).join('\n');
      res.set('Content-Type', 'text/csv');
      return res.send(csv);
    }

    res.json({ period: { year, month, from, to }, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Enneo HR Ops running on http://localhost:${PORT}`);
});
