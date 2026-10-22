import type { DemoState, Port } from './model.ts';
import { locationCountries } from './locations.ts';

/** Flatten only relationships: never turn a grouping label into a new port.
 * Original knowledge keys, revisions, contributions, hats and file references remain
 * unchanged as legacy evidence. The archived metadata keeps those keys resolvable.
 */
export function flattenLocationHierarchy(input: DemoState): DemoState {
  if (input.locationStructureVersion === 1 && !input.locationAreas?.length && !input.ports.some(port => 'areaId' in port)) return input;
  const state = structuredClone(input);
  const groups = state.locationAreas ?? [];
  if (groups.length) state.legacyLocationAreas = [...(state.legacyLocationAreas ?? []), ...groups];
  state.locationCountries = locationCountries(state);
  for (const group of groups) {
    if (group.country.trim() && !state.locationCountries.some(country => country.name.trim().toLocaleLowerCase('en-US') === group.country.trim().toLocaleLowerCase('en-US')))
      state.locationCountries.push({ id: group.country, name: group.country });
  }
  for (const port of state.ports as (Port & { areaId?: string })[]) {
    if (typeof port.areaId === 'string') {
      state.legacyPortAreaIds ??= {};
      state.legacyPortAreaIds[port.id] = port.areaId;
    }
    delete port.areaId;
  }
  delete state.locationAreas;
  state.locationStructureVersion = 1;
  return state;
}
