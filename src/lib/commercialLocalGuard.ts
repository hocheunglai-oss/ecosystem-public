import type { Action } from './model';
/** LIVE commercial records are never mutated through the legacy browser store. */
export function assertLocalCommercialAction(action: Action, dataMode: 'live' | 'test') {
  if (dataMode === 'test') return;
  if (['save-enquiry', 'confirm-enquiry', 'send-enquiry', 'amend-enquiry', 'postpone-enquiry', 'cancel-enquiry',
    'record-stem', 'record-loss', 'record-actual-volume'].includes(action.type)
    || action.type === 'request-credit' && action.enquiryId) {
    throw new Error('Use the shared enquiry workflow. This action is not available for LIVE enquiries.');
  }
}
