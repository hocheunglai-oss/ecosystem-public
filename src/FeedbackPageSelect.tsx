import { feedbackPages } from "./workspaceNavigation";
import { Field } from "./ui";

export default function FeedbackPageSelect({ value, onChange }: {
  value: string; onChange: (value: string) => void;
}) {
  return <Field label="Page (optional)">
    <select aria-label="Page (optional)" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option>
      {feedbackPages.map((page) => <option key={page.id} value={page.id}>{page.label}</option>)}
    </select>
  </Field>;
}
