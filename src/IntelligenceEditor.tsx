import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import { useState } from "react";
import { useDemo } from "./store";
import {
  emptyIntelligenceKeyInfo,
  intelligenceFields,
  INTELLIGENCE_VALUE_MAX_LENGTH,
  sameIntelligenceKeyInfo,
  type IntelligenceKeyInfo,
} from "./lib/intelligenceFields";
import { Field, Modal } from "./ui";

export function IntelligenceEditor({ portId, close }: { portId: string; close: () => void }) {
  const { state, run, toast } = useDemo();
  const port = state.ports.find(item => item.id === portId);
  const current = port?.intelligenceKeyInfo ?? emptyIntelligenceKeyInfo();
  const [baseKeyInfo] = useState<IntelligenceKeyInfo>(() => ({ ...current }));
  const [keyInfo, setKeyInfo] = useState<IntelligenceKeyInfo>(() => ({ ...current }));
  const changed = !sameIntelligenceKeyInfo(current, keyInfo);
  return (
    <Modal title="Update Key Info" onClose={close}>
      {toast?.error && <div className="notice rose" role="alert">{toast.message}</div>}
      {port ? <>
        <p className="modal-intro">{port.name}{port.country !== port.name && ` · ${port.country}`}</p>
        <form onSubmit={event => {
          event.preventDefault();
          const success = run({ type: "save-intelligence", portId, keyInfo, baseKeyInfo, reason: "Key Info updated" }, "Updated.");
          if (success) close();
        }}>
          {intelligenceFields.map(field => (
            <Field label={field.label} key={field.key}>
              <textarea rows={2} maxLength={INTELLIGENCE_VALUE_MAX_LENGTH} value={keyInfo[field.key] ?? ""} onChange={event => {
                const entered = event.target.value;
                setKeyInfo(current => ({ ...current, [field.key]: entered.trim() ? entered : null }));
              }} />
            </Field>
          ))}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={close}>Cancel</button>
            <KnowledgeUpdateButton type="submit" disabled={!changed} />
          </div>
        </form>
      </> : <div className="modal-actions"><button className="button secondary" onClick={close}>Close</button></div>}
    </Modal>
  );
}

export function IntelligenceAmendment({ current, proposed }: {
  current?: IntelligenceKeyInfo;
  proposed: IntelligenceKeyInfo;
}) {
  return <div className="table-wrap intelligence-amendment">
    <table aria-label="Key Info amendment">
      <thead><tr><th>Key Info</th>{current && <th>Current</th>}<th>Proposed</th></tr></thead>
      <tbody>{intelligenceFields.map(field => <tr key={field.key}>
        <th scope="row">{field.label}</th>
        {current && <td>{current[field.key] ?? "—"}</td>}
        <td>{proposed[field.key] ?? "—"}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
