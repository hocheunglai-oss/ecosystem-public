import type { PrivacyNotice } from '../../shared/privacy.ts';

// Account guidance is served only after active membership has been verified.
// Provider infrastructure, routing rules and operational metadata do not belong here.
export const accountPrivacyNotice: PrivacyNotice = {
  sections: [
    { title: 'Information and access', paragraphs: [
      'ECO uses account and work contact details, messages, uploaded documents and activity records to manage sign-in, process business enquiries and fixtures, and support audit and security. Submit only what is needed for your work.',
      'Shared information is available to authorised colleagues according to their access. Private profile tabs belong to their owner. Personal inbox messages remain assigned to their account. Confirmed enquiries can be shared with authorised purchasing staff. Administrators can review submitted parser reports, including source text and corrections.',
    ] },
    { title: 'Sign-in and browser storage', paragraphs: [
      'ECO uses persistent sign-in cookies and browser storage for preferences and local drafts. Signing out, losing the browser cookies or revocation ends the session. A password change invalidates earlier sessions.',
      'Sign out before leaving a shared device. Clearing browser data can remove your sign-in cookies, preferences and unsaved drafts.',
    ] },
    { title: 'Optional AI', paragraphs: [
      'Receiving an enquiry does not automatically send it to AI. Choosing AI Fix sends the enquiry text to an AI service to suggest extracted fields. An administrator can also request AI review of a parser report, including its source text, results, corrections and review notes. Review suggestions before applying them.',
    ] },
    { title: 'Records and requests', paragraphs: [
      'Reading and clearing notifications affects the alert. The original enquiry remains available for business follow-up. Records are retained while needed for trading, audit, security and applicable legal obligations.',
      'Use the privacy notice to contact ECO about access to or correction of your personal data. You can also ask about deletion, subject to applicable law and retention requirements. Include the relevant record and approximate date. Do not send passwords or verification codes.',
    ] },
  ],
};
