import { useEffect, useState } from 'react';
import type { PrivacyNotice } from '../shared/privacy';
import { accessRequest, useAccess } from './auth';
import './privacy.css';

export default function PrivacyDetails() {
  const { realUser } = useAccess();
  return realUser ? <AccountPrivacy key={realUser.id} /> : null;
}

function AccountPrivacy() {
  const [notice, setNotice] = useState<PrivacyNotice | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void accessRequest<PrivacyNotice>('privacy', undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) setNotice(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Privacy information unavailable.');
    });
    return () => controller.abort();
  }, [attempt]);
  return <article className="privacy-details" aria-label="Privacy">
    <h2>Privacy</h2>
    {error ? <div role="alert"><p>{error}</p><button className="ui-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>
      : !notice ? <p role="status">Loading…</p>
      : notice.sections.map(section => <section key={section.title}><h3>{section.title}</h3>
        {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</section>)}
  </article>;
}
