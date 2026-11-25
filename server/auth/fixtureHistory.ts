import type { FixtureHistoryQuery } from '../../shared/fixtureHistory.ts';
import { ApiError } from './validation.ts';

export function fixtureHistoryQuery(url: URL): FixtureHistoryQuery {
  const params = url.searchParams;
  const parties = ['supplierOffice', 'supplierTrader', 'buyerOffice', 'buyerTrader'] as const;
  const invalid = () => new ApiError(400, 'Invalid fixture filters.');
  for (const key of params.keys()) {
    if (!['year', 'month', 'search', 'page', 'deleted', 'view', 'missing', ...parties].includes(key) || params.getAll(key).length !== 1) throw invalid();
  }
  function boundedInteger(key: string, max: number) {
    const value = params.get(key) ?? '0';
    if (!/^\d{1,4}$/.test(value) || Number(value) > max) throw new ApiError(400, 'Invalid fixture filters.');
    return Number(value);
  }
  const year = boundedInteger('year', 2099);
  const month = boundedInteger('month', 12);
  const page = boundedInteger('page', 200);
  const search = params.get('search')?.trim() ?? '';
  if ((year !== 0 && year < 2025) || search.length > 120 || search.includes('\u0000'))
    throw new ApiError(400, 'Invalid fixture filters.');
  const filters: FixtureHistoryQuery = { year, month, page, search };
  for (const key of parties) {
    const value = params.get(key);
    if (value === null) continue;
    const pattern = key.endsWith('Office') ? /^[A-Z0-9 -]{1,80}$/ : /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (!pattern.test(value)) throw invalid();
    filters[key] = value;
  }
  if (params.has('deleted')) {
    if (params.get('deleted') !== '1') throw invalid();
    filters.deleted = true;
  }
  if (params.has('view')) {
    if (params.get('view') !== 'register') throw invalid();
    filters.view = 'register';
  }
  if (params.has('missing')) {
    if (params.get('missing') !== '1' || filters.view !== 'register' || filters.deleted) throw invalid();
    filters.missing = true;
  }
  return filters;
}
