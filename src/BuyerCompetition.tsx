import { useId } from 'react';
import { useDemo } from './store';
import { canTrade } from './lib/model';
import { buyerSharedEntries } from './lib/buyerSharedLists';
import BuyerSharedList from './BuyerSharedList';

export function BuyerCompetition({ buyerId }: { buyerId: string }) {
  const { state, actor } = useDemo();
  const id = useId();
  return <section className="buyer-profile__section buyer-competition" aria-labelledby={id}>
    <header className="buyer-profile__section-header"><h3 id={id}>Competition</h3></header>
    <BuyerSharedList buyerId={buyerId} kind="competition" label="Competition" entries={buyerSharedEntries(state, 'competition', buyerId)} canEdit={canTrade(actor)} />
  </section>;
}
