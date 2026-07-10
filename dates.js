function toDate(d) {
  return d instanceof Date ? d : new Date(`${d}T00:00:00Z`);
}

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function eachDate(start, end) {
  const days = [];
  const cur = new Date(toDate(start));
  const last = toDate(end);
  while (cur <= last) {
    days.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return toDate(aStart) <= toDate(bEnd) && toDate(bStart) <= toDate(aEnd);
}

// Business days = not weekend and not a public holiday for the given country's set.
function countBusinessDays(start, end, holidayDatesSet) {
  return eachDate(start, end).filter(
    (d) => !isWeekend(d) && !holidayDatesSet.has(isoDate(d))
  ).length;
}

module.exports = { toDate, isWeekend, eachDate, isoDate, rangesOverlap, countBusinessDays };
