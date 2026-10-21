import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveState } from '../src/lib/testWorkspace';
import { formatHolidayDate, holidayDates, holidayLocalDate, nextPublicHoliday, publicHolidayCalendar, publicHolidayCalendars } from '../src/lib/publicHolidays';

test('each live jurisdiction has its own official calendar; new names do not get guessed', () => {
  for (const country of createLiveState().locationCountries!) assert.ok(publicHolidayCalendar(country.name), country.name);
  assert.equal(publicHolidayCalendar(' hong kong ')?.code, 'HK');
  assert.equal(publicHolidayCalendar('Gibraltar')?.code, 'GI');
  for (const name of ['Singapore Strait', 'China', 'Korea', 'Canada', '', 'toString', '__proto__']) assert.equal(publicHolidayCalendar(name), undefined);
});

test('today and next use jurisdiction midnight, independent of browser zone and DST', () => {
  const sg = publicHolidayCalendar('Singapore')!;
  assert.equal(holidayLocalDate(new Date('2026-11-07T15:59:59Z'), sg.timeZone), '2026-11-07');
  const today = holidayLocalDate(new Date('2026-11-07T16:00:00Z'), sg.timeZone)!;
  assert.equal(today, '2026-11-08');
  assert.equal(nextPublicHoliday(sg, today)?.name, 'Deepavali');
  assert.equal(nextPublicHoliday(sg, '2026-11-09')?.observedFor, '2026-11-08');
  assert.equal(holidayLocalDate(new Date('2026-03-29T22:30:00Z'), 'Europe/Amsterdam'), '2026-03-30');
  assert.equal(holidayLocalDate(new Date('2026-10-25T22:30:00Z'), 'Europe/Amsterdam'), '2026-10-25');
  assert.equal(holidayLocalDate(new Date(), 'not-a-timezone'), null);
  assert.equal(holidayLocalDate(new Date(NaN), 'Asia/Tokyo'), null);
  assert.equal(formatHolidayDate('2026-01-01'), '1 JAN');
});

test('observed holidays and year rollover retain real dates without weekend extrapolation', () => {
  const sg = publicHolidayCalendar('Singapore')!;
  assert.equal(nextPublicHoliday(sg, '2026-12-26')?.date, '2027-01-01');
  assert.equal(nextPublicHoliday(sg, '2028-01-01'), undefined);
  assert.equal(nextPublicHoliday(sg, 'invalid'), undefined);
  const hk = holidayDates(publicHolidayCalendar('Hong Kong')!, 2026);
  assert.equal(hk.find(day => day.date === '2026-04-07')?.observedFor, '2026-04-06');
  const jp = holidayDates(publicHolidayCalendar('Japan')!, 2026);
  assert.equal(jp.find(day => day.date === '2026-09-22')?.name, "Citizens' holiday");
  assert.equal(jp.find(day => day.date === '2026-05-06')?.observedFor, '2026-05-03');
  assert.ok(!holidayDates(publicHolidayCalendar('Netherlands')!, 2027).some(day => day.date === '2027-12-27'));
  assert.ok(!holidayDates(publicHolidayCalendar('South Korea')!, 2027).some(day => day.date === '2027-06-07'));
});

test('current official additions, sector scopes, and pending lunar dates remain explicit', () => {
  const kr = holidayDates(publicHolidayCalendar('South Korea')!, 2026);
  for (const date of ['2026-05-01', '2026-06-03', '2026-07-17']) assert.ok(kr.some(day => day.date === date));
  const vn = publicHolidayCalendar('Vietnam')!;
  assert.ok(vn.years[2026].holidays.some(day => day.date === '2026-11-24'));
  assert.match(vn.years[2027].notes!.join(), /PRIVATE EMPLOYERS/);
  assert.ok(vn.years[2026].holidays.find(day => day.date === '2026-08-31')?.note?.includes('WORKDAY SWAP'));
  const ae = publicHolidayCalendar('United Arab Emirates')!;
  assert.equal(ae.years[2027].holidays.length, 3);
  assert.ok(ae.years[2027].pending?.length);
  assert.ok(!ae.years[2026].holidays.some(day => day.date === '2026-05-25'), 'federal-only extra Eid day must not become a general holiday');
  assert.match(ae.years[2026].holidays.find(day => day.date === '2026-08-28')!.note!, /FEDERAL/);
  assert.ok(publicHolidayCalendar('Gibraltar')!.years[2027].pending?.some(note => note.includes("KING'S BIRTHDAY")));
});

test('every dated entry has a valid explicit official source and safe calendar date', () => {
  for (const calendar of publicHolidayCalendars) {
    assert.ok(holidayLocalDate(new Date(), calendar.timeZone));
    for (const [year, publication] of Object.entries(calendar.years)) {
      const keys = new Set<string>();
      for (const day of publication.holidays) {
        assert.match(day.date, new RegExp(`^${year}-\\d{2}-\\d{2}$`));
        assert.equal(new Date(`${day.date}T12:00:00Z`).toISOString().slice(0, 10), day.date);
        assert.equal(keys.has(day.date), false, `Duplicate ${calendar.code} ${day.date}`);
        keys.add(day.date);
        assert.ok(day.name.length);
        const url = new URL(publication.sources[day.source].url);
        assert.equal(url.protocol, 'https:');
        if (day.observedFor) assert.match(day.observedFor, /^\d{4}-\d{2}-\d{2}$/);
      }
    }
  }
});
