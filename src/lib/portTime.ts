import type { Port } from "./model";

/** Port-specific IANA zones retain daylight-saving rules without guessing from countries. */
const portTimeZones: Record<string, string> = {
  "port-singapore": "Asia/Singapore",
  "port-hong-kong": "Asia/Hong_Kong",
  "port-rotterdam": "Europe/Amsterdam",
  "port-fujairah": "Asia/Dubai",
  "port-busan": "Asia/Seoul",
  "port-tokyo": "Asia/Tokyo",
  "port-chiba": "Asia/Tokyo",
  "port-yokohama": "Asia/Tokyo",
  "port-osaka": "Asia/Tokyo",
  "port-ho-chi-minh": "Asia/Ho_Chi_Minh",
  "port-gibraltar": "Europe/Gibraltar",
};

const clockOptions: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatInZone(now: Date, timeZone: string): string | undefined {
  try {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-GB", { ...clockOptions, timeZone });
      formatters.set(timeZone, formatter);
    }
    return formatter.format(now);
  } catch {
    return undefined;
  }
}

function portClock(port: Pick<Port, "id" | "timezone">, now: Date): { now: Date; timeZone: string } | undefined {
  if (!Number.isFinite(now.getTime())) return undefined;
  const configured = port.timezone.trim();
  // Explicit IANA data takes precedence over seed defaults.
  if (configured.includes("/") && !/^(?:UTC|GMT)[+-]/i.test(configured)) {
    return { now, timeZone: configured };
  }
  const knownZone = portTimeZones[port.id];
  if (knownZone) return { now, timeZone: knownZone };
  const fixed = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/i.exec(configured);
  if (!fixed) return undefined;
  const hours = Number(fixed[2] ?? 0);
  const minutes = Number(fixed[3] ?? 0);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
  const offsetMinutes = (hours * 60 + minutes) * (fixed[1] === "-" ? -1 : 1);
  return { now: new Date(now.getTime() + offsetMinutes * 60_000), timeZone: "UTC" };
}

/** Unknown or ambiguous timezone data stays unknown; never use the viewer's local clock. */
export function portLocalTime(port: Pick<Port, "id" | "timezone">, now: Date): string | undefined {
  const clock = portClock(port, now);
  return clock && formatInZone(clock.now, clock.timeZone);
}

/** The holiday date must use exactly the same zone/offset as the adjacent clock. */
export function portLocalDate(port: Pick<Port, "id" | "timezone">, now: Date): string | undefined {
  const clock = portClock(port, now);
  if (!clock) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en", { timeZone: clock.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(clock.now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch { return undefined; }
}
