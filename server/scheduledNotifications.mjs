const OPTIONS = {
  morning: ['Good morning, I wish you the best!', 'Good morning'],
  afternoon: ['Stay safe out there!', 'Goodbye!', 'Have a good day!'],
  friday: ['You made it in the week!', 'Have a safe weekend!', 'Hope you have a fun weekend!'],
};

const localClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function scheduledNotificationAt(date, random = Math.random) {
  const parts = Object.fromEntries(localClock.formatToParts(date).map(({ type, value }) => [type, value]));
  const weekday = parts.weekday;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  let key;
  let messages;

  if (weekday === 'Sat' || weekday === 'Sun') return null;
  if (hour === 8 && minute === 15) {
    key = 'morning';
    messages = OPTIONS.morning;
  } else if (hour === 16 && minute === 0 && weekday === 'Fri') {
    key = 'friday-afternoon';
    messages = OPTIONS.friday;
  } else if (hour === 16 && minute === 0) {
    key = 'afternoon';
    messages = OPTIONS.afternoon;
  } else {
    return null;
  }

  return {
    key,
    localDate,
    payload: {
      title: 'Glean',
      body: messages[Math.min(messages.length - 1, Math.floor(random() * messages.length))],
      tag: `glean-scheduled-${key}-${localDate}`,
      kind: 'announcement',
      url: '/',
    },
  };
}

export function createScheduledNotifications({ database, pushService, now = () => new Date() }) {
  database.exec(`CREATE TABLE IF NOT EXISTS notification_schedule_runs (
    schedule_key TEXT NOT NULL,
    local_date TEXT NOT NULL,
    PRIMARY KEY (schedule_key, local_date)
  ) STRICT`);
  const claimRun = database.prepare('INSERT INTO notification_schedule_runs (schedule_key, local_date) VALUES (?, ?) ON CONFLICT DO NOTHING');

  function tick() {
    const scheduled = scheduledNotificationAt(now());
    if (!scheduled) return false;
    if (Number(claimRun.run(scheduled.key, scheduled.localDate).changes) === 0) return false;
    pushService.notifyAll(scheduled.payload);
    return true;
  }

  function start() {
    tick();
    const timer = setInterval(tick, 15_000);
    timer.unref?.();
    return timer;
  }

  return { start, tick };
}
