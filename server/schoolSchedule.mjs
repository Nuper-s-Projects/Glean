const formatters = new Map();

function zonedParts(date, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function localTimeToEpoch({ year, month, day, hour, minute }, timeZone) {
  const targetWallTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetWallTime;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const local = zonedParts(new Date(guess), timeZone);
    const representedWallTime = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const adjustment = targetWallTime - representedWallTime;
    if (!adjustment) break;
    guess += adjustment;
  }
  return guess;
}

export function getSchoolAccessState(now = new Date(), timeZone = 'America/Chicago') {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('A valid current time is required.');
  const local = zonedParts(current, timeZone);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday);
  const minuteOfDay = local.hour * 60 + local.minute;
  const closingMinute = local.weekday === 'Fri' ? 14 * 60 + 15 : 16 * 60;
  const blocked = weekdayIndex >= 1 && weekdayIndex <= 5 && minuteOfDay >= 8 * 60 + 15 && minuteOfDay < closingMinute;
  if (!blocked) return { available: true, nextOpenAt: null, timeZone };

  const openHour = local.weekday === 'Fri' ? 14 : 16;
  const openMinute = local.weekday === 'Fri' ? 15 : 0;
  return {
    available: false,
    nextOpenAt: localTimeToEpoch({ ...local, hour: openHour, minute: openMinute }, timeZone),
    timeZone,
  };
}

export function getManagedSchoolAccessState(now = new Date(), timeZone = 'America/Chicago', allowDuringSchoolHours = false) {
  const scheduled = getSchoolAccessState(now, timeZone);
  return allowDuringSchoolHours ? { ...scheduled, available: true, nextOpenAt: null, scheduleOverride: true } : scheduled;
}
