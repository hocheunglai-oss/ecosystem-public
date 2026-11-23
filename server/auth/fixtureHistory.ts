import { fixtureHistoryYears, type FixtureHistoryQuery } from '../../shared/fixtureHistory.ts';
import { ApiError } from './validation.ts';

export function fixtureHistoryQuery(url: URL): FixtureHistoryQuery {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!['year', 'month', 'search', 'page'].includes(key) || params.getAll(key).length !== 1)
      throw new ApiError(400, 'Invalid fixture filters.');
  }
  function boundedInteger(key: string, max: number) {
    const value = params.get(key) ?? '0';
    if (!/^\d{1,4}$/.test(value) || Number(value) > max) throw new ApiError(400, 'Invalid fixture filters.');
    return Number(value);
  }
  const year = boundedInteger('year', Math.max(...fixtureHistoryYears));
  const month = boundedInteger('month', 12);
  const page = boundedInteger('page', 200);
  const search = params.get('search')?.trim() ?? '';
  if ((year !== 0 && !fixtureHistoryYears.some(value => value === year)) || search.length > 120 || search.includes('\u0000'))
    throw new ApiError(400, 'Invalid fixture filters.');
  return { year, month, page, search };
}
