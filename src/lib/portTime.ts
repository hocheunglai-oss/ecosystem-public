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

/** Unknown or ambiguous timezone data stays unknown; never use the viewer's local clock. */
export function portLocalTime(port: Pick<Port, "id" | "timezone">, now: Date): string | undefined {
  if (!Number.isFinite(now.getTime())) return undefined;
  const configured = port.timezone.trim();
  // Explicit IANA data takes precedence over seed defaults.
  if (configured.includes("/") && !/^(?:UTC|GMT)[+-]/i.test(configured)) {
    return formatInZone(now, configured);
  }
  const knownZone = portTimeZones[port.id];
  if (knownZone) return formatInZone(now, knownZone);
  const fixed = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/i.exec(configured);
  if (!fixed) return undefined;
  const hours = Number(fixed[2] ?? 0);
  const minutes = Number(fixed[3] ?? 0);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
  const offsetMinutes = (hours * 60 + minutes) * (fixed[1] === "-" ? -1 : 1);
  return formatInZone(new Date(now.getTime() + offsetMinutes * 60_000), "UTC");
}
