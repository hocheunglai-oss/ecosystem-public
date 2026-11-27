import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useTestWorkspace } from './TestWorkspace';
import './knowledge-update-button.css';

export default function KnowledgeUpdateButton({ children, className = '', contribution = true, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode; contribution?: boolean }) {
  const { developerMode } = useTestWorkspace();
  const credited = developerMode && contribution;
  return <button {...props} type={type} aria-description={credited ? 'CONTRIBUTION +1' : undefined}
    className={`button ${credited ? 'knowledge-update-button ui-button--contribution' : 'secondary'} ${className}`}>
    {credited ? <span className="contribution-action-labels">
      <span className="contribution-action-label">{children ?? (type === 'submit' ? 'SAVE' : 'EDIT')}</span>
      <span className="contribution-action-hint" aria-hidden="true">CONTRIBUTION +1</span>
    </span> : children ?? (type === 'submit' ? 'SAVE' : 'EDIT')}
  </button>;
}
