import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './knowledge-update-button.css';

export default function KnowledgeUpdateButton({ children = 'CONTRIBUTE +1', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) {
  return <button type="button" {...props} className={`button knowledge-update-button ${className}`}>{children}</button>;
}
