export type HatStandingEntry = { actorId: string; count: number };

/** Equal totals share competition rank; progress means passing the next higher total. */
export function hatStanding(ranking: readonly HatStandingEntry[], actorId: string) {
  const count = ranking.find(entry => entry.actorId === actorId)?.count ?? 0;
  const rank = count > 0 ? 1 + ranking.filter(entry => entry.count > count).length : null;
  const tied = rank !== null && ranking.filter(entry => entry.count === count).length > 1;
  const higher = ranking.filter(entry => entry.count > count);
  if (!count) return { count, rank, tied, next: { count: 1, needed: 1, rank: 1 + ranking.filter(entry => entry.count > 1).length, kind: 'enter' as const } };
  if (!higher.length) return { count, rank, tied, next: tied ? { count: count + 1, needed: 1, rank: 1, kind: 'lead' as const } : null };
  const nextCount = Math.min(...higher.map(entry => entry.count)) + 1;
  return { count, rank, tied, next: { count: nextCount, needed: nextCount - count,
    rank: 1 + ranking.filter(entry => entry.count > nextCount).length, kind: 'advance' as const } };
}
