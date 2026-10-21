import { intelligenceFields, type IntelligenceKeyInfo } from './lib/intelligenceFields';

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
