import { env } from '../config/env.js';

// Local wall-clock times (operating hours, the date a user picks) are in the platform's
// fixed UTC offset. India has no daylight saving, so a constant offset is exact.
const offsetMs = () => env.utcOffsetMinutes * 60_000;

export function localToUtc(dateStr, hhmm = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - offsetMs());
}

export function localParts(date) {
  const shifted = new Date(date.getTime() + offsetMs());
  return {
    date: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

// "11:00 AM" in local time, for notification text.
export function formatLocalTime(date) {
  const { minutes } = localParts(date);
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// morning, afternoon or evening in local time, for grouping slots.
export function partOfDay(date) {
  const { minutes } = localParts(date);
  return minutes < 12 * 60 ? 'morning' : minutes < 17 * 60 ? 'afternoon' : 'evening';
}
