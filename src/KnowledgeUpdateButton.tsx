import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './knowledge-update-button.css';

export default function KnowledgeUpdateButton({ children, className = '', contribution = true, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode; contribution?: boolean }) {
  return <button {...props} type={type} aria-description={contribution ? 'CONTRIBUTION +1' : undefined}
    className={`button ${contribution ? 'knowledge-update-button ui-button--contribution' : 'secondary'} ${className}`}>
    {contribution ? <span className="contribution-action-labels">
      <span className="contribution-action-label">{children ?? (type === 'submit' ? 'SAVE' : 'EDIT')}</span>
      <span className="contribution-action-hint" aria-hidden="true">CONTRIBUTION +1</span>
    </span> : children ?? (type === 'submit' ? 'SAVE' : 'EDIT')}
  </button>;
}
