import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useDemo } from "./store";
import { uid, isAdmin } from "./lib/model";
import { lostReasonsFor, type LostReason } from "./lib/lostReasons";

export default function LostReasonSettings() {
  const { state, actor, run } = useDemo();
  const [reasons, setReasons] = useState<LostReason[]>(() =>
    lostReasonsFor(state).map((reason) => ({ ...reason })),
  );
  useEffect(() => {
    setReasons(lostReasonsFor(state).map((reason) => ({ ...reason })));
  }, [state.lostReasons]);
  if (!isAdmin(actor)) return null;
  const change = (id: string, patch: Partial<LostReason>) => {
    setReasons((current) =>
      current.map((reason) =>
        reason.id === id ? { ...reason, ...patch } : reason,
      ),
    );
  };
  const move = (index: number, direction: -1 | 1) => {
    setReasons((current) => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  };
  return (
    <section className="lost-reason-settings" aria-label="Lost reasons">
      <h3>Lost reasons</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run({ type: "save-lost-reasons", reasons }, "Lost reasons saved.");
        }}
      >
        <div className="lost-reason-list">
          {reasons.map((reason, index) => (
            <div key={reason.id} className="lost-reason-row">
              <input
                value={reason.label}
                aria-label={`Reason ${index + 1}`}
                required
                onChange={(event) =>
                  change(reason.id, { label: event.target.value })
                }
              />
              <label className="check-label">
                <input
                  type="checkbox"
                  aria-label={`Active: ${reason.label || `Reason ${index + 1}`}`}
                  checked={reason.active}
                  onChange={(event) =>
                    change(reason.id, { active: event.target.checked })
                  }
                />
                Active
              </label>
              <button
                type="button"
                className="icon-button"
                disabled={index === 0}
                aria-label={`Move up: ${reason.label || `Reason ${index + 1}`}`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={index === reasons.length - 1}
                aria-label={`Move down: ${reason.label || `Reason ${index + 1}`}`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove reason: ${reason.label || `Reason ${index + 1}`}`}
                onClick={() =>
                  setReasons((current) =>
                    current.filter((item) => item.id !== reason.id),
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setReasons((current) => [
                ...current,
                { id: uid("lost-reason"), label: "", active: true },
              ])
            }
          >
            <Plus size={15} />
            Add reason
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={!reasons.some((reason) => reason.active)}
          >
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
