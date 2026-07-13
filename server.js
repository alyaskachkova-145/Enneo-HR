require('dotenv').config();
const path = require('path');
const express = require('express');
const { randomUUID } = require('crypto');
const { supabase } = require('./db');
const slack = require('./slack');
const { rangesOverlap, countBusinessDays, isoDate, toDate } = require('./dates');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Session auth backed by employees table (per-user credentials, role-aware) ---
const sessions = new Map(); // token -> employee id

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((pair) => {
      const [k, ...v] = pair.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
}

function requireAuth(req, res, next) {
  const { session } = parseCookies(req);
  if (session && sessions.has(session)) {
    req.employeeId = sessions.get(session);
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

// Admin-only guard (team configuration + role management)
async function requireAdmin(req, res, next) {
  const { session } = parseCookies(req);
  const employeeId = session && sessions.get(session);
  if (!employeeId) return res.status(401).json({ error: 'Not authenticated' });
  const { data: me } = await supabase.from('employees').select('is_admin').eq('id', employeeId).single();
  if (!me?.is_admin) return res.status(403).json({ error: 'Admins only' });
  req.employeeId = employeeId;
  next();
}

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { data: employee } = await supabase
    .from('employees')
    .select('id, password')
    .eq('email', email || '')
    .single();
  if (!employee || employee.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = randomUUID();
  sessions.set(token, employee.id);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const { session } = parseCookies(req);
  sessions.delete(session);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/auth/me', async (req, res) => {
  const { session } = parseCookies(req);
  const employeeId = session && sessions.get(session);
  if (!employeeId) return res.status(401).json({ error: 'Not authenticated' });
  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, name, email, role, country, slack_user_id, approver_id, is_admin, is_approver')
    .eq('id', employeeId)
    .single();
  if (error || !employee) return res.status(401).json({ error: 'Not authenticated' });
  let approver_name = null;
  if (employee.approver_id) {
    const { data: approver } = await supabase.from('employees').select('name').eq('id', employee.approver_id).single();
    approver_name = approver?.name || null;
  }
  res.json({ ...employee, approver_name });
});

async function getEmployeeBySlackId(slackUserId) {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('slack_user_id', slackUserId)
    .single();
  if (error) throw error;
  return data;
}

async function getEmployeeById(id) {
  const { data, error } = await supabase.from('employees').select('*').eq('id', id).single();
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

    if (!employee.approver_id) {
      return res.status(400).json({ error: `${employee.name} has no approver assigned — add one before requesting time off` });
    }

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

    const approver = await getEmployeeById(employee.approver_id);
    const notification = slack.notifyApprovers([approver], inserted, employee);

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
    if (!approver) return res.status(403).json({ error: 'Unknown approver' });

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

    const employee = await getEmployeeById(request.employee_id);
    if (employee.approver_id !== approver.id) {
      return res.status(403).json({ error: `Only ${employee.name}'s assigned approver can act on this request` });
    }

    const { data: updated, error: updErr } = await supabase
      .from('holiday_requests')
      .update({ status, approver_id: approver.id, decided_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

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

// --- Simple report: approved holiday days per employee for a period (month|quarter|year) ---
app.get('/report', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getUTCFullYear();
    const month = parseInt(req.query.month, 10) || now.getUTCMonth() + 1; // 1-12
    const period = req.query.period || 'month'; // month | quarter | year
    const pad = (n) => String(n).padStart(2, '0');

    let from, to, periodLabel;
    if (period === 'year') {
      from = `${year}-01-01`;
      to = `${year}-12-31`;
      periodLabel = `${year}`;
    } else if (period === 'quarter') {
      const q = Math.floor((month - 1) / 3); // 0-3
      const startMonth = q * 3 + 1;
      const endMonth = startMonth + 2;
      from = `${year}-${pad(startMonth)}-01`;
      to = `${year}-${pad(endMonth)}-${pad(new Date(Date.UTC(year, endMonth, 0)).getUTCDate())}`;
      periodLabel = `${year}-Q${q + 1}`;
    } else {
      from = `${year}-${pad(month)}-01`;
      to = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
      periodLabel = `${year}-${pad(month)}`;
    }

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
      const header = `period,${periodLabel} (${from} to ${to})\nemployee,country,business_days_off\n`;
      const csv = header + rows.map((r) => `${r.employee},${r.country},${r.business_days_off}`).join('\n');
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', `attachment; filename="holiday-report-${periodLabel}.csv"`);
      return res.send(csv);
    }

    res.json({ period: { period, label: periodLabel, from, to }, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Employees directory + manual add ---
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const { data: employees, error } = await supabase.from('employees').select('*').order('name');
    if (error) throw error;
    const byId = Object.fromEntries(employees.map((e) => [e.id, e.name]));
    const { data: teams } = await supabase.from('teams').select('id, name');
    const teamById = Object.fromEntries((teams || []).map((t) => [t.id, t.name]));
    res.json({
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        email: e.email,
        role: e.role,
        is_admin: e.is_admin,
        is_approver: e.is_approver,
        country: e.country,
        approver_id: e.approver_id,
        approver_name: e.approver_id ? byId[e.approver_id] || null : null,
        team_id: e.team_id,
        team_name: e.team_id ? teamById[e.team_id] || null : null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, country, is_admin, is_approver, approver_id, team_id } = req.body || {};
    if (!name || !email || !password || !country) {
      return res.status(400).json({ error: 'name, email, password, country are required' });
    }

    // If a team is chosen, its lead becomes the approver
    let resolvedApprover = approver_id || null;
    if (team_id) {
      const { data: team } = await supabase.from('teams').select('lead_id').eq('id', team_id).single();
      if (team?.lead_id) resolvedApprover = team.lead_id;
    }

    const approver = !!is_approver;
    const { data: inserted, error } = await supabase
      .from('employees')
      .insert({
        id: randomUUID(),
        name,
        email,
        password,
        country,
        role: approver ? 'approver' : 'employee',
        is_admin: !!is_admin,
        is_approver: approver,
        approver_id: resolvedApprover,
        team_id: team_id || null,
        slack_user_id: `U_${name.split(' ')[0].toUpperCase()}_${randomUUID().slice(0, 4)}`,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'An employee with this email already exists' });
      if (error.code === '23503') return res.status(400).json({ error: 'Unknown country, team or approver' });
      throw error;
    }
    res.status(201).json({ employee: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: update an employee's roles / team / approver
app.patch('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    const { is_admin, is_approver, team_id, approver_id } = req.body || {};
    const patch = {};
    if (is_admin !== undefined) patch.is_admin = !!is_admin;
    if (is_approver !== undefined) { patch.is_approver = !!is_approver; patch.role = is_approver ? 'approver' : 'employee'; }
    if (approver_id !== undefined) patch.approver_id = approver_id || null;
    if (team_id !== undefined) {
      patch.team_id = team_id || null;
      if (team_id) {
        const { data: team } = await supabase.from('teams').select('lead_id').eq('id', team_id).single();
        if (team?.lead_id) patch.approver_id = team.lead_id; // team lead approves for the team
      }
    }
    const { data, error } = await supabase.from('employees').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ employee: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Teams (admin-managed groups, led by an approver) ---
app.get('/api/teams', requireAuth, async (req, res) => {
  try {
    const [{ data: teams, error: tErr }, { data: employees, error: eErr }] = await Promise.all([
      supabase.from('teams').select('*').order('name'),
      supabase.from('employees').select('id, name, team_id'),
    ]);
    if (tErr) throw tErr;
    if (eErr) throw eErr;
    const nameById = Object.fromEntries(employees.map((e) => [e.id, e.name]));
    res.json({
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        lead_id: t.lead_id,
        lead_name: t.lead_id ? nameById[t.lead_id] || null : null,
        members: employees.filter((e) => e.team_id === t.id).map((e) => e.name),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/teams', requireAdmin, async (req, res) => {
  try {
    const { name, lead_id } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { data, error } = await supabase
      .from('teams')
      .insert({ id: randomUUID(), name, lead_id: lead_id || null })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ team: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Countries directory + manual add ---
app.get('/api/countries', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('countries').select('*').order('name');
    if (error) throw error;
    res.json({ countries: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/countries', requireAdmin, async (req, res) => {
  try {
    const { code, name, holiday_source_url } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const { data: inserted, error } = await supabase
      .from('countries')
      .insert({ code: code.toUpperCase(), name, holiday_source_url: holiday_source_url || null })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Country code already exists' });
      throw error;
    }
    res.status(201).json({ country: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set/update a country's holiday source (BY is pinned to calendar.by)
app.patch('/api/countries/:code', requireAdmin, async (req, res) => {
  try {
    const { holiday_source_url } = req.body || {};
    const { data, error } = await supabase
      .from('countries')
      .update({ holiday_source_url: holiday_source_url || null })
      .eq('code', req.params.code.toUpperCase())
      .select()
      .single();
    if (error) throw error;
    res.json({ country: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Public holiday awareness: upcoming holidays + who's unavailable by location ---
app.get('/api/holiday-awareness', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 60;
    const today = new Date();
    const from = isoDate(today);
    const to = isoDate(new Date(today.getTime() + days * 86400000));

    const [{ data: holidays, error: holErr }, { data: employees, error: empErr }, { data: countries, error: cErr }] =
      await Promise.all([
        supabase.from('public_holidays').select('*').gte('holiday_date', from).lte('holiday_date', to).order('holiday_date'),
        supabase.from('employees').select('name, country'),
        supabase.from('countries').select('*'),
      ]);
    if (holErr) throw holErr;
    if (empErr) throw empErr;
    if (cErr) throw cErr;

    const employeesByCountry = {};
    for (const e of employees) (employeesByCountry[e.country] = employeesByCountry[e.country] || []).push(e.name);
    const countryName = Object.fromEntries(countries.map((c) => [c.code, c.name]));

    const upcoming = holidays.map((h) => ({
      country: h.country,
      country_name: countryName[h.country] || h.country,
      holiday_date: h.holiday_date,
      name: h.name,
      unavailable: employeesByCountry[h.country] || [],
    }));

    const notification = slack.holidayAwarenessMessage(upcoming);

    res.json({ range: { from, to, days }, upcoming, slack_message_preview: notification });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Requests list (for the approvals table / history) ---
// scope=my-approvals -> only requests belonging to employees this user approves for
// scope=mine         -> only this user's own requests
app.get('/api/requests', requireAuth, async (req, res) => {
  try {
    const { status, limit, scope } = req.query;
    const needsInnerJoin = scope === 'my-approvals';
    let query = supabase
      .from('holiday_requests')
      .select(`*, employees!holiday_requests_employee_id_fkey${needsInnerJoin ? '!inner' : ''}(name, country, approver_id)`)
      .order('created_at', { ascending: false })
      .limit(limit ? parseInt(limit, 10) : 50);
    if (status) query = query.eq('status', status);
    if (scope === 'my-approvals') query = query.eq('employees.approver_id', req.employeeId);
    if (scope === 'mine') query = query.eq('employee_id', req.employeeId);
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      requests: data.map((r) => ({
        id: r.id,
        employee: r.employees.name,
        country: r.employees.country,
        start_date: r.start_date,
        end_date: r.end_date,
        reason: r.reason,
        status: r.status,
        conflict_warning: r.conflict_warning,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard: everything the browser overview needs in one call ---
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const range = req.query.range || 'month'; // 'month' | 'quarter' | 'year'
    const today = new Date();
    const year = today.getUTCFullYear();

    let periodFrom, periodTo;
    if (range === 'year') {
      periodFrom = `${year}-01-01`;
      periodTo = `${year}-12-31`;
    } else if (range === 'quarter') {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - 89);
      periodFrom = isoDate(d);
      periodTo = isoDate(today);
    } else {
      periodFrom = `${year}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(year, today.getUTCMonth() + 1, 0)).getUTCDate();
      periodTo = `${year}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    const [{ data: employees, error: empErr }, { data: allRequests, error: reqErr }, { data: allHolidays, error: holErr }] =
      await Promise.all([
        supabase.from('employees').select('*').order('name'),
        supabase.from('holiday_requests').select('*, employees!holiday_requests_employee_id_fkey(name, country, approver_id)').order('created_at', { ascending: false }),
        supabase.from('public_holidays').select('*').order('holiday_date'),
      ]);
    if (empErr) throw empErr;
    if (reqErr) throw reqErr;
    if (holErr) throw holErr;

    const holidaysByCountry = {};
    for (const h of allHolidays) {
      holidaysByCountry[h.country] = holidaysByCountry[h.country] || new Set();
      holidaysByCountry[h.country].add(h.holiday_date);
    }

    const pendingCount = allRequests.filter((r) => r.status === 'pending').length;

    const approvedInPeriod = allRequests.filter(
      (r) => r.status === 'approved' && r.start_date <= periodTo && r.end_date >= periodFrom
    );

    const daysOffByEmployee = {};
    const daysOffByCountry = {};
    let totalBusinessDaysOff = 0;
    for (const r of approvedInPeriod) {
      const clampedStart = r.start_date < periodFrom ? periodFrom : r.start_date;
      const clampedEnd = r.end_date > periodTo ? periodTo : r.end_date;
      const holidaySet = holidaysByCountry[r.employees.country] || new Set();
      const days = countBusinessDays(clampedStart, clampedEnd, holidaySet);
      totalBusinessDaysOff += days;
      daysOffByEmployee[r.employees.name] = (daysOffByEmployee[r.employees.name] || 0) + days;
      daysOffByCountry[r.employees.country] = (daysOffByCountry[r.employees.country] || 0) + days;
    }

    // "Out this week" — distinct employees whose approved time off overlaps the current Mon–Sun week
    const dow = (today.getUTCDay() + 6) % 7; // Mon=0
    const weekStart = new Date(today); weekStart.setUTCDate(today.getUTCDate() - dow);
    const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    const wFrom = isoDate(weekStart), wTo = isoDate(weekEnd);
    const outThisWeek = new Set(
      allRequests
        .filter((r) => r.status === 'approved' && r.start_date <= wTo && r.end_date >= wFrom)
        .map((r) => r.employees.name)
    ).size;

    res.json({
      period: { range, from: periodFrom, to: periodTo },
      stats: {
        team_members: employees.length,
        pending_count: pendingCount,
        approved_count: approvedInPeriod.length,
        total_business_days_off: totalBusinessDaysOff,
        out_this_week: outThisWeek,
      },
      recent_requests: allRequests.slice(0, 20).map((r) => ({
        id: r.id,
        employee: r.employees.name,
        country: r.employees.country,
        approver_id: r.employees.approver_id,
        start_date: r.start_date,
        end_date: r.end_date,
        reason: r.reason,
        status: r.status,
        conflict_warning: r.conflict_warning,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  const { session } = parseCookies(req);
  if (!session || !sessions.has(session)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static('public', { index: false }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Enneo HR Ops running on http://localhost:${PORT}`);
});
