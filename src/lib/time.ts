export function todayKey(now = new Date()) {
  const offsetMinutes = Number(process.env.TRADING_TIMEZONE_OFFSET_MINUTES ?? 330);
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function resetSessionKey(resetTime: string, now = new Date()) {
  const offsetMinutes = Number(process.env.TRADING_TIMEZONE_OFFSET_MINUTES ?? 330);
  const [hours, minutes] = resetTime.split(":").map(Number);
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  if (shifted.getUTCHours() * 60 + shifted.getUTCMinutes() < hours * 60 + minutes) {
    shifted.setUTCDate(shifted.getUTCDate() - 1);
  }
  return shifted.toISOString().slice(0, 10);
}

export function istDayBounds(now = new Date()) {
  const offsetMinutes = Number(process.env.TRADING_TIMEZONE_OFFSET_MINUTES ?? 330);
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const startShifted = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0));
  const start = new Date(startShifted.getTime() - offsetMinutes * 60_000);
  return { day: shifted.toISOString().slice(0, 10), start, end: now };
}

export function secondsUntil(time: string, now = new Date()) {
  const [hours, minutes] = time.split(":").map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return Math.floor((target.getTime() - now.getTime()) / 1000);
}

export function isTimeBetween(start: string, end: string, now = new Date()) {
  const current = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const from = sh * 60 + sm;
  const to = eh * 60 + em;
  return from <= to ? current >= from && current <= to : current >= from || current <= to;
}

export function isPast(time: string, now = new Date()) {
  const current = now.getHours() * 60 + now.getMinutes();
  const [hours, minutes] = time.split(":").map(Number);
  return current >= hours * 60 + minutes;
}
