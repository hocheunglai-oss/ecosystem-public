import { supplierPortById } from '../../shared/supplierPorts.ts';
import type { PortFixtureQuery } from '../../shared/portFixtureReports.ts';
import { ApiError } from './validation.ts';

export function portFixtureQuery(url: URL): PortFixtureQuery {
  const { searchParams } = url;
  const view = searchParams.get('view');
  const portId = searchParams.get('portId') ?? '';
  const search = searchParams.get('search')?.trim() ?? '';
  const page = searchParams.get('page') ?? '0';
  const keys = [...searchParams.keys()];
  const validView = view === 'prices' || view === 'ranking' || view === 'statistics';
  if (!validView || !supplierPortById(portId)
    || (view === 'statistics' && portId !== 'port-singapore')
    || keys.some(key => !(view === 'prices' ? ['view', 'portId', 'search', 'page'] : ['view', 'portId']).includes(key))
    || new Set(keys).size !== keys.length || search.length > 160 || /[\u0000-\u001f\u007f]/.test(search) || !/^\d{1,4}$/.test(page)) {
    throw new ApiError(400, 'Invalid fixture report filters.');
  }
  return { view, portId, search, page: Number(page) };
}
