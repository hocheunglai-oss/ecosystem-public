import type { KnowledgeTarget } from "./knowledge";
import type { DemoState, Port } from "./model";

export interface LocationCountry {
  id: string;
  name: string;
}
/** Deserialization/history compatibility only; never an active location type. */
export interface LegacyLocationArea {
  id: string;
  name: string;
  country: string;
}
export interface LocationRecord {
  key: string;
  target: KnowledgeTarget;
  name: string;
  kind: "country" | "port";
  country?: string;
  path: string;
  updatedAt?: string;
}

const normalized = (value: string) => value.trim().toLocaleLowerCase("en-US");
const portCountryName = (port: Port) => port.id === "port-hong-kong" ? "Hong Kong" : port.country;

/** Resolve old links without changing the original knowledge/history keys. */
export function legacyLocationGroup(state: DemoState, id: string): LegacyLocationArea | undefined {
  return (state.legacyLocationAreas ?? state.locationAreas ?? []).find(item => item.id === id);
}


/** Country IDs are names to preserve the existing country knowledge keys. */
export function locationCountries(state: DemoState): LocationCountry[] {
  const countries = [...(state.locationCountries ?? [])];
  for (const port of state.ports) {
    const name = portCountryName(port);
    if (
      normalized(name) &&
      !countries.some(
        (country) => normalized(country.name) === normalized(name),
      )
    ) {
      countries.push({ id: name, name });
    }
  }
  return countries.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Resolve the registered relationship, independently of the profile's display path. */
function countryForPort(countries: LocationCountry[], port: Port): LocationCountry | undefined {
  const name = portCountryName(port);
  if (!normalized(name)) return;
  const exact = countries.filter(country => country.name === name);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const matches = countries.filter(country => normalized(country.name) === normalized(name));
  return matches.length === 1 ? matches[0] : undefined;
}
export function locationCountryForPort(state: DemoState, port: Port): LocationCountry | undefined {
  return countryForPort(locationCountries(state), port);
}

/** Every country and port owns a distinct information record. */
export function canonicalLocationTarget(
  state: DemoState,
  target: KnowledgeTarget,
): KnowledgeTarget {
  if (target.kind !== "country") return target;
  const country = locationCountries(state).find(
    (item) => item.id === target.id || item.name === target.id,
  );
  return country ? { kind: "country", id: country.id } : target;
}

// Navigation only: country and port knowledge, private tabs and audit identities
// remain separate even when their information is shown together.
function countryProfilePort(state: DemoState, country: LocationCountry, countries = locationCountries(state)) {
  const candidates = countries.filter(item => normalized(item.name) === normalized(country.name));
  const matches = state.ports.filter(port => countryForPort(candidates, port)?.id === country.id);
  return matches.length === 1 ? matches[0] : undefined;
}
/** Resolve navigation, without changing storage keys or original audit records. */
export function locationProfileTarget(state: DemoState, target: KnowledgeTarget): KnowledgeTarget {
  if (target.kind === "area") {
    const legacy = legacyLocationGroup(state, target.id);
    return legacy ? locationProfileTarget(state, { kind: "country", id: legacy.country }) : target;
  }
  const actual = canonicalLocationTarget(state, target);
  if (actual.kind !== "country") return actual;
  const country = locationCountries(state).find(item => item.id === actual.id);
  const port = country && countryProfilePort(state, country);
  return port ? { kind: "port", id: port.id } : actual;
}
/** Country-owned content remains editable in its original record inside the port profile. */
export function profileCountryTarget(state: DemoState, target: KnowledgeTarget): KnowledgeTarget | undefined {
  if (target.kind !== "port") return;
  const port = state.ports.find(item => item.id === target.id);
  const country = port && locationCountryForPort(state, port);
  if (!port || !country || countryProfilePort(state, country)?.id !== port.id) return;
  return country ? { kind: "country", id: country.id } : undefined;
}

export function locationRecords(state: DemoState): LocationRecord[] {
  const countries = locationCountries(state);
  const key = (target: KnowledgeTarget) => {
    const canonical = canonicalLocationTarget(state, target);
    return `${canonical.kind}:${canonical.id}`;
  };
  const latest = new Map<string, string>();
  const recordDate = (target: KnowledgeTarget, date?: string) => {
    if (!date || !Number.isFinite(Date.parse(date))) return;
    const targetKey = key(target);
    if (
      !latest.has(targetKey) ||
      Date.parse(date) > Date.parse(latest.get(targetKey)!)
    )
      latest.set(targetKey, date);
  };
  for (const history of state.knowledgeHistory ?? [])
    recordDate(history.target, history.at);
  for (const item of state.contributions) {
    if (
      item.status === "approved" &&
      ["country", "port"].includes(item.targetType)
    ) {
      recordDate(
        { kind: item.targetType as KnowledgeTarget["kind"], id: item.targetId },
        item.publishedAt ?? item.reviewedAt ?? item.createdAt,
      );
    }
  }
  const updatedAt = (target: KnowledgeTarget, original?: string) => {
    recordDate(target, original);
    return latest.get(key(target));
  };
  const profileUpdatedAt = (country: LocationCountry, port: Port) => {
    const dates = [
      updatedAt({ kind: "country", id: country.id }),
      updatedAt({ kind: "port", id: port.id }, port.updatedAt),
    ].filter((date): date is string => Boolean(date));
    return dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  };
  const records: LocationRecord[] = [];
  for (const country of countries) {
    const target: KnowledgeTarget = { kind: "country", id: country.id };
    const port = countryProfilePort(state, country, countries);
    records.push({
      key: `country:${country.id}`,
      target,
      name: country.name,
      kind: "country",
      path: country.name,
      updatedAt: port ? profileUpdatedAt(country, port) : updatedAt(target),
    });
  }
  for (const port of state.ports) {
    const target: KnowledgeTarget = { kind: "port", id: port.id };
    const parent = countryForPort(countries, port);
    const country = parent?.name ?? portCountryName(port);
    const combined = parent && countryProfilePort(state, parent, countries)?.id === port.id;
    records.push({
      key: `port:${port.id}`,
      target,
      name: port.name,
      kind: "port",
      country,
      path: combined && normalized(port.name) === normalized(country)
        ? port.name
        : [country, port.name].filter(Boolean).join(" › "),
      updatedAt: combined ? profileUpdatedAt(parent, port) : updatedAt(target, port.updatedAt),
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

/** Root-to-parent breadcrumbs; the current record is deliberately excluded. */
export function locationAncestors(
  state: DemoState,
  target: KnowledgeTarget,
): LocationRecord[] {
  const canonical = locationProfileTarget(state, target);
  const records = locationRecords(state);
  const current = records.find(
    (record) => record.key === `${canonical.kind}:${canonical.id}`,
  );
  if (!current || current.kind === "country") return [];
  const countryTarget = locationProfileTarget(state, {
    kind: "country",
    id: current.country ?? "",
  });
  const country = records.find(
    (record) =>
      record.key === `${countryTarget.kind}:${countryTarget.id}` &&
      record.key !== current.key,
  );
  return country ? [country] : [];
}

/** Country pages list every port directly, without an intermediate location type. */
export function locationChildren(
  state: DemoState,
  target: KnowledgeTarget,
): LocationRecord[] {
  const canonical = canonicalLocationTarget(state, target);
  if (canonical.kind !== "country") return [];
  const countries = locationCountries(state);
  const country = countries.find(item => item.id === canonical.id);
  if (!country) return [];
  const ports = new Set(state.ports.filter(port => countryForPort(countries, port)?.id === country.id).map(port => port.id));
  return locationRecords(state).filter(record => record.kind === "port" && ports.has(record.target.id));
}
