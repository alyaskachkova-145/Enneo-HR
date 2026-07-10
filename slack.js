// Mock Slack layer for the hackathon demo.
// Real Slack app connection is deferred ("connectors later") — this module is
// the single seam to swap in @slack/bolt without touching route logic.
// Every "message" is logged to the console formatted like a Slack post, and
// also returned to the caller so the demo can show it without a live workspace.

function notifyApprovers(approvers, request, employee) {
  const text =
    `:palm_tree: *Holiday request* from *${employee.name}* (${employee.country})\n` +
    `${request.start_date} → ${request.end_date}` +
    (request.reason ? `\n> ${request.reason}` : '') +
    (request.conflict_warning ? `\n:warning: ${request.conflict_warning}` : '') +
    `\n[Approve] [Reject]  (request ${request.id})`;

  for (const approver of approvers) {
    console.log(`\n[SLACK → @${approver.name}]\n${text}\n`);
  }

  return { channel: 'dm:approvers', recipients: approvers.map((a) => a.name), text };
}

function notifyDecision(request, employee, approver) {
  const verb = request.status === 'approved' ? 'approved :white_check_mark:' : 'rejected :x:';
  const text =
    `Your holiday request (${request.start_date} → ${request.end_date}) was ${verb} by *${approver.name}*.`;

  console.log(`\n[SLACK → @${employee.name}]\n${text}\n`);

  return { channel: `dm:${employee.name}`, text };
}

function weeklyDigestMessage(outNextWeek, backNextWeek, rangeLabel) {
  const outLines = outNextWeek.length
    ? outNextWeek.map((r) => `• ${r.employee.name} (${r.start_date} → ${r.end_date})`).join('\n')
    : '• nobody 🎉';
  const backLines = backNextWeek.length
    ? backNextWeek.map((r) => `• ${r.employee.name} (back ${r.end_date_plus_one})`).join('\n')
    : '• nobody';

  const text =
    `:calendar: *Weekly holiday digest — ${rangeLabel}*\n\n` +
    `*Out next week:*\n${outLines}\n\n` +
    `*Back next week:*\n${backLines}`;

  console.log(`\n[SLACK → #team-updates]\n${text}\n`);

  return { channel: '#team-updates', text };
}

module.exports = { notifyApprovers, notifyDecision, weeklyDigestMessage };
