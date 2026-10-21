import { actors } from "./lib/model";
import { hatRanking } from "./lib/hats";
import { useDemo } from "./store";
import { ResourceIcon } from "./ResourceWallet";
import { number } from "./ui";

export function HatRanking({ id, className = "" }: { id?: string; className?: string }) {
  const { actor, state } = useDemo();
  const ranking = hatRanking(state);
  let displayedRank = 0;

  return (
    <section id={id} className={`hat-ranking ${className}`} aria-label="Hat ranking">
      <h2><ResourceIcon kind="hat" size={19} /> Hat ranking</h2>
      {ranking.length ? (
        <ol className="hat-ranking-list" tabIndex={0} aria-label="Hat ranking">
          {ranking.map((entry, index) => {
            if (!index || entry.count !== ranking[index - 1].count) displayedRank = index + 1;
            const person = entry.actorId === actor.id ? actor : actors.find((candidate) => candidate.id === entry.actorId);
            const email = person ? undefined : state.profiles?.[entry.actorId]?.email?.trim() || undefined;
            return (
              <li key={entry.actorId} data-current-user={entry.actorId === actor.id || undefined}>
                <span className="hat-ranking-position" aria-label={`Rank ${displayedRank}`}>{displayedRank}</span>
                <span className="hat-ranking-name" data-email-value={email ? "" : undefined}>{person?.name ?? email ?? "CONTRIBUTOR"}</span>
                <strong aria-label={`${number(entry.count)} Hats`}><ResourceIcon kind="hat" size={16} />{number(entry.count)}</strong>
              </li>
            );
          })}
        </ol>
      ) : <p className="hat-ranking-empty" aria-label="No Hats yet">—</p>}
    </section>
  );
}
