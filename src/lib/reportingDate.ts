/** Shared Hong Kong calendar date; independent of the browser's local timezone. */
export const reportingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
