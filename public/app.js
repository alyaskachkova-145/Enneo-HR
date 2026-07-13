const state = { range: 'month', currentUser: null, countries: [], calYear: 2026, calMonth: 6 };
const PALETTE = ['#7B5AE2', '#38A870', '#6F91ED', '#F6B100', '#957BE8', '#DB5151'];
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Stable, distinct-ish color per employee name (so a multi-day vacation reads as one colour block)
function empColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 50%, 52%)`;
}

function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}
const FLAG = new Proxy({}, { get: (_, code) => flagEmoji(String(code)) });

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function initials(name) {
  return name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function fmtRange(start, end) {
  return `${start} → ${end}`;
}

function renderWelcome() {
  const name = state.currentUser?.name;
  document.getElementById('welcome').textContent = `Welcome back${name ? ', ' + name : ''}`;
  document.getElementById('today').textContent = new Date().toLocaleDateString('en-US', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  if (state.currentUser) {
    const roles = [];
    if (state.currentUser.is_admin) roles.push('Admin');
    if (state.currentUser.is_approver) roles.push('Approver');
    if (!roles.length) roles.push('Employee');
    document.getElementById('signed-in-name').textContent = `${state.currentUser.name} · ${roles.join(', ')}`;
  }
}

function applyRoleVisibility() {
  const isAdmin = !!state.currentUser?.is_admin;
  document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !isAdmin; });
}

function renderStats(stats) {
  document.getElementById('stat-team').textContent = stats.team_members;
  document.getElementById('stat-pending').textContent = stats.pending_count;
  document.getElementById('stat-out').textContent = stats.out_this_week;
}

// Sidebar badge reflects what the current user can act on (their scope), not the org total.
function setPendingBadge(count) {
  const badge = document.getElementById('pending-badge');
  if (count > 0) {
    badge.hidden = false;
    badge.textContent = count;
  } else {
    badge.hidden = true;
  }
}

// Can the current user act on this request? (approver assigned to that employee, request still pending)
function canDecide(r) {
  return state.currentUser?.is_approver
    && r.status === 'pending'
    && r.approver_id === state.currentUser.id;
}

function renderRecent(rows) {
  const body = document.getElementById('recent-body');
  body.innerHTML = rows.length
    ? rows.map((r) => `
      <tr>
        <td>${r.employee} <span class="flag">${FLAG[r.country] || ''}</span></td>
        <td>${fmtRange(r.start_date, r.end_date)}</td>
        <td>${r.reason || '—'}</td>
        <td><span class="badge-status ${r.status}">${r.status}</span></td>
        <td class="row-actions">${canDecide(r)
          ? `<button class="btn small prim-ghost" data-approve="${r.id}">Approve</button>
             <button class="btn small danger-ghost" data-reject="${r.id}">Reject</button>`
          : ''}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" class="empty-note">No requests yet.</td></tr>';

  body.querySelectorAll('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', () => decide(btn.dataset.approve, 'approve')));
  body.querySelectorAll('[data-reject]').forEach((btn) =>
    btn.addEventListener('click', () => decide(btn.dataset.reject, 'reject')));
}

function renderApprovals(rows) {
  const isApprover = state.currentUser?.is_approver;
  const list = document.getElementById('approvals-list');
  list.innerHTML = rows.length
    ? rows.map((r) => `
      <div class="req-row">
        <div class="avatar">${initials(r.employee)}</div>
        <div class="req-main">
          <div class="req-name">${r.employee} <span class="flag">${FLAG[r.country] || ''}</span></div>
          <div class="req-meta">${fmtRange(r.start_date, r.end_date)}${r.reason ? ' · ' + r.reason : ''}</div>
          ${r.conflict_warning ? `<div class="req-meta" style="color:var(--yellow)">⚠ ${r.conflict_warning}</div>` : ''}
        </div>
        ${isApprover
          ? `<div class="req-actions">
              <button class="btn small prim-ghost" data-approve="${r.id}">Approve</button>
              <button class="btn small danger-ghost" data-reject="${r.id}">Reject</button>
            </div>`
          : '<span class="badge-status pending">pending</span>'}
      </div>
    `).join('')
    : '<div class="empty-note">No pending requests. 🎉</div>';

  list.querySelectorAll('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', () => decide(btn.dataset.approve, 'approve')));
  list.querySelectorAll('[data-reject]').forEach((btn) =>
    btn.addEventListener('click', () => decide(btn.dataset.reject, 'reject')));
}

// ---- Month-grid calendar: overlapping vacations + public holidays ----
function pad2(n) { return String(n).padStart(2, '0'); }

function renderCalendarGrid(teamHolidays, publicHolidays) {
  const y = state.calYear;
  const m = state.calMonth; // 0-indexed
  document.getElementById('cal-month-label').textContent = `${MONTH_FULL[m]} ${y}`;

  const holidaysByDate = {};
  for (const h of publicHolidays) (holidaysByDate[h.holiday_date] = holidaysByDate[h.holiday_date] || []).push(h);

  const todayIso = new Date().toISOString().slice(0, 10);
  const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let cells = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');

  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell pad"></div>';

  const offNames = new Set();
  let overlapDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${y}-${pad2(m + 1)}-${pad2(day)}`;
    const dow = new Date(Date.UTC(y, m, day)).getUTCDay();
    const isWeekend = dow === 0 || dow === 6;

    const hols = holidaysByDate[iso] || [];
    const off = teamHolidays.filter((r) => r.start_date <= iso && r.end_date >= iso);
    off.forEach((r) => offNames.add(r.employee));
    if (off.length >= 2) overlapDays++;

    const holHtml = hols.map((h) => `<div class="cal-hol">${FLAG[h.country]}<span class="hn" title="${h.name} (${h.country})">${h.name}</span></div>`).join('');
    const shown = off.slice(0, 3);
    const offHtml = shown.map((r) =>
      `<div class="cal-off" style="background:${empColor(r.employee)}" title="${r.employee} (${r.country})"><span class="nm">${r.employee.split(' ')[0]}</span></div>`
    ).join('');
    const moreHtml = off.length > 3 ? `<div class="cal-more">+${off.length - 3} more</div>` : '';

    const cls = ['cal-cell'];
    if (isWeekend) cls.push('weekend');
    if (hols.length) cls.push('holiday');
    if (iso === todayIso) cls.push('today');

    cells += `<div class="${cls.join(' ')}"><span class="cal-daynum">${day}</span>${holHtml}${offHtml}${moreHtml}</div>`;
  }

  document.getElementById('cal-grid').innerHTML = cells;

  // Legend: only employees who appear this month, + holiday swatch
  const legend = document.getElementById('cal-legend');
  const names = [...offNames].sort();
  legend.innerHTML =
    '<span class="lg holiday"><i></i>Public holiday</span>' +
    names.map((n) => `<span class="lg"><i style="background:${empColor(n)}"></i>${n}</span>`).join('') +
    (overlapDays ? `<span class="cal-overlap-note">· ${overlapDays} day(s) with 2+ people off</span>` : '');
}

async function loadCalendarGrid() {
  const from = `${state.calYear}-${pad2(state.calMonth + 1)}-01`;
  const lastDay = new Date(Date.UTC(state.calYear, state.calMonth + 1, 0)).getUTCDate();
  const to = `${state.calYear}-${pad2(state.calMonth + 1)}-${pad2(lastDay)}`;
  const data = await fetchJSON(`/calendar?from=${from}&to=${to}`);
  renderCalendarGrid(data.team_holidays, data.public_holidays);
}

function roleTags(e) {
  const tags = [];
  if (e.is_admin) tags.push('<span class="role-tag admin">admin</span>');
  if (e.is_approver) tags.push('<span class="role-tag approver">approver</span>');
  if (!e.is_admin && !e.is_approver) tags.push('<span class="role-tag employee">employee</span>');
  return tags.join('');
}

function renderEmployees(rows) {
  const body = document.getElementById('employees-body');
  body.innerHTML = rows.map((e) => `
    <tr>
      <td>${e.name} <span class="flag">${FLAG[e.country]}</span></td>
      <td>${e.country}</td>
      <td>${e.team_name || '—'}</td>
      <td>${roleTags(e)}</td>
      <td>${e.approver_name || '—'}</td>
    </tr>
  `).join('');
}

function renderTeams(teams) {
  const list = document.getElementById('teams-list');
  list.innerHTML = teams.length
    ? teams.map((t) => `
      <div class="team-card">
        <div class="tname">${t.name}</div>
        <div class="tlead">Lead: ${t.lead_name || '—'}</div>
        <div class="tmembers">${t.members.length ? t.members.join(', ') : 'No members yet'}</div>
      </div>
    `).join('')
    : '<div class="empty-note">No teams yet.</div>';
}

// Admin table: toggle admin/approver + reassign team per person
function renderRolesTable(employees, teams) {
  const body = document.getElementById('roles-body');
  const teamOpts = (sel) => '<option value="">— none —</option>' +
    teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${t.name}</option>`).join('');
  body.innerHTML = employees.map((e) => `
    <tr>
      <td>${e.name} <span class="flag">${FLAG[e.country]}</span></td>
      <td><input type="checkbox" class="roles-toggle" data-role-admin="${e.id}" ${e.is_admin ? 'checked' : ''}></td>
      <td><input type="checkbox" class="roles-toggle" data-role-approver="${e.id}" ${e.is_approver ? 'checked' : ''}></td>
      <td><select data-role-team="${e.id}">${teamOpts(e.team_id)}</select></td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-role-admin]').forEach((el) =>
    el.addEventListener('change', () => patchEmployee(el.dataset.roleAdmin, { is_admin: el.checked })));
  body.querySelectorAll('[data-role-approver]').forEach((el) =>
    el.addEventListener('change', () => patchEmployee(el.dataset.roleApprover, { is_approver: el.checked })));
  body.querySelectorAll('[data-role-team]').forEach((el) =>
    el.addEventListener('change', () => patchEmployee(el.dataset.roleTeam, { team_id: el.value || null })));
}

async function patchEmployee(id, patch) {
  try {
    await fetchJSON(`/api/employees/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await loadTeamAdmin();
    await loadDashboard();
  } catch (err) {
    alert(`Update failed: ${err.message}`);
    await loadTeamAdmin();
  }
}

async function loadTeamAdmin() {
  const [empData, teamData] = await Promise.all([fetchJSON('/api/employees'), fetchJSON('/api/teams')]);
  state.employees = empData.employees;
  state.teams = teamData.teams;
  renderEmployees(empData.employees);
  renderTeams(teamData.teams);
  if (state.currentUser?.is_admin) renderRolesTable(empData.employees, teamData.teams);
}

function renderCountries(rows) {
  const list = document.getElementById('countries-list');
  list.innerHTML = rows.map((c) => `
    <div class="country-row">
      <span class="flag">${FLAG[c.code]}</span>
      <span class="cname">${c.name}</span>
      ${c.holiday_source_url
        ? `<a class="csrc" href="${c.holiday_source_url}" target="_blank" rel="noopener">${c.holiday_source_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>`
        : '<span class="csrc missing">no source set</span>'}
      ${state.currentUser?.is_admin ? `<button class="btn small sec cedit" data-edit-source="${c.code}">Edit source</button>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('[data-edit-source]').forEach((btn) =>
    btn.addEventListener('click', () => openSourceModal(btn.dataset.editSource)));
}

function renderAwareness(rows) {
  const list = document.getElementById('awareness-list');
  list.innerHTML = rows.length
    ? rows.map((h) => {
        const [y, m, d] = h.holiday_date.split('-');
        return `
        <div class="aw-row">
          <div class="aw-date">
            <div class="d">${d}</div>
            <div class="m">${MONTH_LABELS[parseInt(m, 10) - 1]}</div>
          </div>
          <div class="aw-main">
            <div class="aw-title">${FLAG[h.country]} ${h.name} <span class="date" style="color:var(--fg-3);font-weight:400">· ${h.country_name}</span></div>
            <div class="aw-people">
              ${h.unavailable.length
                ? 'Unavailable: ' + h.unavailable.map((n) => `<span class="aw-chip">${n}</span>`).join('')
                : 'Nobody based there'}
            </div>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty-note">No public holidays in the next 60 days.</div>';
}

async function loadEmployees() {
  const data = await fetchJSON('/api/employees');
  renderEmployees(data.employees);
  return data.employees;
}

async function loadCountries() {
  const data = await fetchJSON('/api/countries');
  state.countries = data.countries;
  renderCountries(data.countries);
  return data.countries;
}

async function loadAwareness() {
  const data = await fetchJSON('/api/holiday-awareness?days=90');
  renderAwareness(data.upcoming);
}

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

function openRequestModal() {
  document.getElementById('request-error').hidden = true;
  document.getElementById('request-form').reset();
  const approverNote = document.getElementById('req-approver-note');
  approverNote.innerHTML = state.currentUser?.approver_name
    ? `Goes to your approver: <b>${state.currentUser.approver_name}</b>`
    : 'No approver assigned to you yet — ask HR to set one.';
  openModal('request-modal');
}

function openSourceModal(code) {
  const country = state.countries.find((c) => c.code === code);
  if (!country) return;
  document.getElementById('source-error').hidden = true;
  document.getElementById('source-country-note').innerHTML =
    `${FLAG[country.code]} <b>${country.name}</b>`;
  document.getElementById('source-url').value = country.holiday_source_url || '';
  document.getElementById('source-form').dataset.code = code;
  openModal('source-modal');
}

async function openEmployeeModal() {
  const [empData, countries, teamData] = await Promise.all([
    fetchJSON('/api/employees'), loadCountries(), fetchJSON('/api/teams'),
  ]);
  document.getElementById('emp-country').innerHTML =
    countries.map((c) => `<option value="${c.code}">${FLAG[c.code]} ${c.name}</option>`).join('');
  document.getElementById('emp-team').innerHTML = '<option value="">— none —</option>' +
    teamData.teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  const approvers = empData.employees.filter((e) => e.is_approver);
  document.getElementById('emp-approver').innerHTML = '<option value="">— none —</option>' +
    approvers.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
  document.getElementById('employee-error').hidden = true;
  document.getElementById('employee-form').reset();
  document.getElementById('emp-password').value = 'enneo';
  openModal('employee-modal');
}

async function openTeamModal() {
  const empData = await fetchJSON('/api/employees');
  const approvers = empData.employees.filter((e) => e.is_approver);
  document.getElementById('team-lead').innerHTML = '<option value="">— none —</option>' +
    approvers.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
  document.getElementById('team-error').hidden = true;
  document.getElementById('team-form').reset();
  openModal('team-modal');
}

async function decide(id, action) {
  try {
    await fetchJSON(`/slack/actions/${id}/${action === 'approve' ? 'approve' : 'reject'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver_slack_user_id: state.currentUser.slack_user_id }),
    });
    await loadAll();
  } catch (err) {
    alert(`Could not ${action}: ${err.message}`);
  }
}

async function loadDashboard() {
  const dash = await fetchJSON('/api/dashboard');
  renderWelcome();
  renderStats(dash.stats);
  renderRecent(dash.recent_requests);
}

async function loadApprovals() {
  const scope = state.currentUser?.is_approver ? 'my-approvals' : 'mine';
  const data = await fetchJSON(`/api/requests?status=pending&limit=50&scope=${scope}`);
  renderApprovals(data.requests);
  setPendingBadge(data.requests.length);
  const hint = document.getElementById('approvals-hint');
  if (hint) {
    hint.textContent = state.currentUser?.is_approver
      ? 'requests routed to you'
      : 'your requests awaiting approval';
  }
}

async function loadAll() {
  await loadCountries();
  await Promise.all([loadDashboard(), loadApprovals(), loadCalendarGrid(), loadTeamAdmin(), loadAwareness()]);
}

function wireEvents() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');
      document.getElementById(item.dataset.section).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const shiftMonth = (delta) => {
    let m = state.calMonth + delta;
    let y = state.calYear;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.calMonth = m;
    state.calYear = y;
    loadCalendarGrid();
  };
  document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
  document.getElementById('cal-today').addEventListener('click', () => {
    const now = new Date();
    state.calYear = now.getFullYear();
    state.calMonth = now.getMonth();
    loadCalendarGrid();
  });

  const downloadReport = (period) => {
    const now = new Date();
    window.open(`/report?year=${now.getFullYear()}&month=${now.getMonth() + 1}&period=${period}&format=csv`, '_blank');
  };
  document.getElementById('generate-report').addEventListener('click', () => downloadReport('month'));
  document.getElementById('download-report').addEventListener('click', () =>
    downloadReport(document.getElementById('report-period').value));

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  document.getElementById('request-off-btn').addEventListener('click', openRequestModal);

  document.getElementById('request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('request-error');
    errorBox.hidden = true;
    try {
      await fetchJSON('/slack/commands/holiday', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slack_user_id: state.currentUser.slack_user_id,
          start_date: document.getElementById('req-start').value,
          end_date: document.getElementById('req-end').value,
          reason: document.getElementById('req-reason').value || null,
        }),
      });
      closeModal('request-modal');
      await loadAll();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });

  document.getElementById('source-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('source-error');
    errorBox.hidden = true;
    const code = document.getElementById('source-form').dataset.code;
    try {
      await fetchJSON(`/api/countries/${code}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holiday_source_url: document.getElementById('source-url').value || null }),
      });
      closeModal('source-modal');
      await loadCountries();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });

  document.getElementById('add-employee-btn').addEventListener('click', openEmployeeModal);
  document.getElementById('create-team-btn').addEventListener('click', openTeamModal);
  document.getElementById('add-country-btn').addEventListener('click', () => {
    document.getElementById('country-error').hidden = true;
    document.getElementById('country-form').reset();
    openModal('country-modal');
  });

  document.getElementById('team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('team-error');
    errorBox.hidden = true;
    try {
      await fetchJSON('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('team-name').value,
          lead_id: document.getElementById('team-lead').value || null,
        }),
      });
      closeModal('team-modal');
      await loadTeamAdmin();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });

  document.getElementById('employee-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('employee-error');
    errorBox.hidden = true;
    try {
      await fetchJSON('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('emp-name').value,
          email: document.getElementById('emp-email').value,
          password: document.getElementById('emp-password').value,
          country: document.getElementById('emp-country').value,
          team_id: document.getElementById('emp-team').value || null,
          approver_id: document.getElementById('emp-approver').value || null,
          is_approver: document.getElementById('emp-is-approver').checked,
          is_admin: document.getElementById('emp-is-admin').checked,
        }),
      });
      closeModal('employee-modal');
      await Promise.all([loadTeamAdmin(), loadDashboard()]);
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });

  document.getElementById('country-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById('country-error');
    errorBox.hidden = true;
    try {
      await fetchJSON('/api/countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: document.getElementById('country-code').value,
          name: document.getElementById('country-name').value,
        }),
      });
      closeModal('country-modal');
      await loadCountries();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });
}

async function init() {
  const me = await fetch('/auth/me');
  if (!me.ok) {
    window.location.href = '/login';
    return;
  }
  state.currentUser = await me.json();
  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();
  document.documentElement.style.scrollBehavior = 'smooth';
  wireEvents();
  renderWelcome();
  applyRoleVisibility();
  await loadAll();
}

init();
