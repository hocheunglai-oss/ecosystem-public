import { actors } from "./lib/model";
import { hatCount, hatRanking, recentHatsReceived } from "./lib/hats";
import { hatStanding } from "./lib/hatStanding";
import { useDemo } from "./store";
import { ResourceIcon } from "./ResourceWallet";
import { number } from "./ui";
import { useAccess } from "./auth";
import { canPreviewAppearance } from "../shared/appearancePreview";
import "./hats-off.css";

export type HatsAppearancePreview = "none" | "received";
export const hatsPreviewCounts: Record<HatsAppearancePreview, number> = { none: 0, received: 5 };

const date = (value: string) => new Date(value).toLocaleDateString("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Hong_Kong",
});

/** Appearance samples never enter the award ledger or change the actual ranking. */
export function HatsOffPanel({ preview = null, canPreview = false, onPreviewChange }: {
  preview?: HatsAppearancePreview | null;
  canPreview?: boolean;
  onPreviewChange?: (preview: HatsAppearancePreview | null) => void;
}) {
  const { actor, state } = useDemo();
  const { realUser } = useAccess();
  const previewAllowed = canPreview && canPreviewAppearance(realUser);
  const displayedPreview = previewAllowed ? preview : null;
  const count = displayedPreview ? hatsPreviewCounts[displayedPreview] : hatCount(state, actor.id);
  const contributor = (id: string) => {
    const person = id === actor.id ? actor : actors.find(candidate => candidate.id === id);
    const email = person ? undefined : state.profiles?.[id]?.email?.trim() || undefined;
    return { name: person?.name ?? email ?? "CONTRIBUTOR", email: Boolean(email) };
  };
  const ranking = displayedPreview ? [
    { actorId: "sample-trader-a", count: 8, name: "SAMPLE TRADER A", email: false },
    ...(displayedPreview === "received" ? [{ actorId: actor.id, count: 5, name: "YOU (PREVIEW)", email: false }] : []),
    { actorId: "sample-trader-b", count: 3, name: "SAMPLE TRADER B", email: false },
  ] : hatRanking(state).map(entry => ({ ...entry, ...contributor(entry.actorId) }));
  const recent = displayedPreview === "received" ? ["A", "B", "C", "A", "A"].map((letter, index) => ({
    id: `sample-hat-${index}`, name: `SAMPLE TRADER ${letter}`, email: false,
    awardedAt: new Date(Date.now() - index * 86_400_000).toISOString(),
  })) : displayedPreview ? [] : recentHatsReceived(state, actor.id).map(award => ({
    id: award.id, ...contributor(award.readerId), awardedAt: award.awardedAt,
  }));
  const standing = hatStanding(ranking, actor.id);
  const hasTies = new Set(ranking.map(entry => entry.count)).size < ranking.length;
  let displayedRank = 0;

  return <div className="hats-off-panel" data-appearance-preview={Boolean(displayedPreview)}>
    {displayedPreview && <p className="hats-off-preview-note" role="status">PREVIEW · SAMPLE HATS AND PEOPLE</p>}
    <section className="hats-off-hero" aria-label="Your Hats standing" data-has-hats={count > 0}>
      <div className="hats-off-hero-top">
        <span className="hats-off-emblem" aria-hidden="true"><ResourceIcon kind="hat" size={48} /></span>
        <div className="hats-off-total"><strong>{number(count)}</strong><span>{count === 1 ? "HAT RECEIVED" : "HATS RECEIVED"}</span></div>
        <div className="hats-off-your-rank"><span>YOUR RANK</span><strong>{standing.rank ? `#${standing.rank}` : "—"}</strong>
          {standing.tied && <small>SHARED</small>}</div>
      </div>
      <p className="hats-off-guidance">{count === 0
        ? "EARN HATS BY SHARING USEFUL CONTRIBUTIONS. COLLEAGUES CAN SELECT HATS OFF ON YOUR UPDATES."
        : "EVERY HAT IS A COLLEAGUE’S THANKS FOR KNOWLEDGE WORTH SHARING."}</p>
      <div className="hats-off-next">
        {standing.next ? <>
          <p><strong>{number(standing.next.needed)} {standing.next.needed === 1 ? "HAT" : "HATS"}</strong> {standing.next.kind === "enter" ? "TO ENTER THE RANKING" : standing.next.kind === "lead" ? "TO LEAD OUTRIGHT" : `TO RANK #${standing.next.rank}`}</p>
          <div className="hats-off-progress" role="progressbar" aria-label="Hats towards your next rank"
            aria-valuemin={0} aria-valuemax={standing.next.count} aria-valuenow={count}>
            <span style={{ width: `${Math.min(100, count / standing.next.count * 100)}%` }} />
          </div>
        </> : <p><strong>LEADING THE RANKING</strong> · KEEP SHARING USEFUL KNOWLEDGE.</p>}
      </div>
    </section>
    <section className="hats-off-ranking" aria-label="Hats ranking">
      <div className="hats-off-section-heading"><h3>HATS RANKING</h3><span>ALL TIME</span></div>
      {ranking.length ? <ol className="hats-off-ranking-list" aria-label="Hats ranking" data-size={Math.min(ranking.length, 3)}>
        {ranking.map((entry, index) => {
          if (!index || entry.count !== ranking[index - 1].count) displayedRank = index + 1;
          return <li key={entry.actorId} data-current-user={entry.actorId === actor.id || undefined} data-place={displayedRank <= 3 ? displayedRank : undefined}>
            <span className="hats-off-rank" aria-label={`Rank ${displayedRank}`}>{displayedRank}</span>
            <span className="hats-off-name" data-email-value={entry.email ? "" : undefined}>{entry.name}</span>
            <strong aria-label={`${number(entry.count)} Hats`}><ResourceIcon kind="hat" size={16} />{number(entry.count)}</strong>
            {entry.actorId === actor.id && <span className="hats-off-you">YOU</span>}
          </li>;
        })}
      </ol> : <div className="hats-off-first"><span aria-hidden="true"><ResourceIcon kind="hat" size={38} /></span>
        <p className="hats-off-empty">NO HATS YET</p><strong>BE THE FIRST ON THE BOARD.</strong></div>}
      {hasTies && <p className="hats-off-tie-note">EQUAL HAT TOTALS SHARE A RANK.</p>}
    </section>
    {count > 0 && <section className="hats-off-recent" aria-label="Recently received hats">
      <h3>RECENTLY RECEIVED</h3>
      {recent.length ? <ol className="hats-off-recent-list">
        {recent.map(award => <li key={award.id}>
          <span className="hats-off-recent-icon" aria-hidden="true"><ResourceIcon kind="hat" size={19} /></span>
          <span className="hats-off-name" data-email-value={award.email ? "" : undefined}>{award.name}</span>
          <time dateTime={award.awardedAt}>{date(award.awardedAt)}</time>
        </li>)}
      </ol> : <p className="hats-off-empty">NO RECENT DETAILS AVAILABLE</p>}
    </section>}
    {previewAllowed && onPreviewChange && <label className="hats-off-appearance-preview">APPEARANCE PREVIEW
      <select aria-label="Hats appearance preview" value={displayedPreview ?? "actual"}
        onChange={event => onPreviewChange(event.target.value === "actual" ? null : event.target.value as HatsAppearancePreview)}>
        <option value="actual">ACTUAL HATS</option>
        <option value="none">NO HATS</option>
        <option value="received">HATS RECEIVED</option>
      </select>
      {displayedPreview && <span>PREVIEW ONLY · YOUR HATS ARE UNCHANGED.</span>}
    </label>}
  </div>;
}
