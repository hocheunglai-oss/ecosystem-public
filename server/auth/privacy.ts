import type { PrivacyNotice } from '../../shared/privacy.ts';

// Account guidance is served only after active membership has been verified.
// Provider infrastructure, routing rules and operational metadata do not belong here.
export const accountPrivacyNotice: PrivacyNotice = {
  sections: [
    { title: 'Information and access', paragraphs: [
      'ECO processes account details, business enquiries, messages, uploaded documents and changes made within the application. Only submit information needed for your work.',
      'Shared information is available to authorised colleagues according to their access. Private profile tabs belong to their owner. Personal inbox messages remain assigned to their account. Administrators can review submitted parser reports, including source text and corrections.',
    ] },
    { title: 'Sign-in and browser storage', paragraphs: [
      'ECO uses persistent sign-in cookies and browser storage for preferences and local drafts. Your session continues while the browser retains its cookies, unless you sign out or access is revoked. A password change invalidates earlier sessions.',
      'Sign out before leaving a shared device. Clearing browser data can remove your sign-in cookies, preferences and unsaved drafts.',
    ] },
    { title: 'Optional AI', paragraphs: [
      'Receiving an enquiry does not automatically send it to AI. Choosing AI Fix sends the enquiry text to an AI service to suggest extracted fields. An administrator can also request AI review of a parser report, including its source text, results, corrections and review notes. Review suggestions before applying them.',
    ] },
    { title: 'Records and requests', paragraphs: [
      'Reading or dismissing a notification does not delete its stored record. Enquiry and review records can remain available for business follow-up and audit.',
      'To request access, correction or deletion, contact your administrator with the relevant record and approximate date. Do not send passwords or verification codes.',
    ] },
  ],
};
