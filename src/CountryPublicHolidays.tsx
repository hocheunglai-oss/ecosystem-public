import { useEffect, useId, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Modal } from './ui';
import { HOLIDAYS_CHECKED_ON, formatHolidayDate, holidayDates, holidayLocalDate, nextHolidayIsComplete, nextPublicHoliday, publicHolidayCalendar, todayPublicHoliday } from './lib/publicHolidays';
import { portLocalDate } from './lib/portTime';
import type { Port } from './lib/model';
import './public-holidays.css';

type HolidayCalendarProps = { country: string; timezone?: string; port?: Pick<Port, 'id' | 'timezone'> };

export default function CountryPublicHolidays(props: HolidayCalendarProps) {
  return <HolidayCalendar key={`${props.country}:${props.port?.id ?? ''}:${props.port?.timezone ?? props.timezone ?? ''}`} {...props} />;
}

function HolidayCalendar({ country, timezone, port }: HolidayCalendarProps) {
  const calendar = publicHolidayCalendar(country);
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const hintId = useId();
  const statusId = useId();
  const localDate = port ? portLocalDate(port, now) ?? null : timezone ? holidayLocalDate(now, timezone) : calendar ? holidayLocalDate(now, calendar.timeZone) : null;
  const currentYear = localDate ? Number(localDate.slice(0, 4)) : now.getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = todayPublicHoliday(calendar, localDate);
  const status = today.kind === 'holiday' ? `PUBLIC HOLIDAY (${today.holidays.map(day => day.name.toUpperCase()).join(' / ')})`
    : today.kind === 'nonholiday' ? 'TODAY IS NOT A PUBLIC HOLIDAY'
    : today.kind === 'unconfirmed' ? 'PUBLIC HOLIDAY STATUS UNCONFIRMED' : 'PUBLIC HOLIDAY DATES UNAVAILABLE';
  const next = calendar && localDate ? nextPublicHoliday(calendar, localDate, false) : undefined;
  const nextText = next ? `${nextHolidayIsComplete(calendar!, localDate!, next) ? 'NEXT' : 'NEXT PUBLISHED'}: ${formatHolidayDate(next.date, true)} · ${next.name.toUpperCase()}${next.status === 'scheduled' ? ' (SCHEDULED)' : ''}`
    : 'NEXT PUBLIC HOLIDAY NOT YET AVAILABLE.';
  const publication = calendar?.years[year];
  const years = [...new Set([currentYear, ...Object.keys(calendar?.years ?? {}).map(Number)])].sort();
  const days = calendar ? holidayDates(calendar, year) : [];
  return <>
    <span className="public-holidays-control" data-hint-hidden={open || hintDismissed || undefined}
      onPointerEnter={() => setHintDismissed(false)} onFocus={() => setHintDismissed(false)}
      onKeyDown={event => { if (event.key === 'Escape' && !open && !hintDismissed) { event.preventDefault(); event.stopPropagation(); setHintDismissed(true); } }}>
      <button type="button" className="button secondary public-holidays-trigger" aria-label="Public holidays" aria-describedby={`${statusId} ${hintId}`} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { setYear(currentYear); setOpen(true); }}>
        <CalendarDays size={16} aria-hidden="true" />
        <span id={statusId} className={today.kind === 'holiday' ? 'public-holidays-today' : undefined}>{status}</span>
      </button>
      <span id={hintId} role="tooltip" className="public-holidays-hint">{nextText}</span>
    </span>
    {open && <Modal title="PUBLIC HOLIDAYS" kicker={country.toUpperCase()} onClose={() => setOpen(false)}>
      <div className="public-holidays">
        <p className="public-holidays-next">{nextText}</p>
        {calendar ? <>
          <div className="public-holidays-toolbar">
            <label>YEAR <select aria-label="Holiday year" value={year} onChange={event => setYear(Number(event.target.value))}>
              {years.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
            <span>CHECKED {formatHolidayDate(HOLIDAYS_CHECKED_ON, true)}</span>
          </div>
          {!publication && <p role="status">OFFICIAL DATES NOT YET AVAILABLE FOR {year}.</p>}
          {publication?.notes?.map(note => <p className="public-holidays-note" key={note}>{note}</p>)}
          {publication?.pending?.map(note => <p className="public-holidays-note" key={note}>AWAITING CONFIRMATION: {note}</p>)}
          {days.length > 0 && <table aria-label={`${country} public holidays ${year}`}>
            <thead><tr><th scope="col">DATE</th><th scope="col">HOLIDAY</th></tr></thead>
            <tbody>{days.map(day => <tr key={`${day.date}:${day.name}`} aria-current={day.date === localDate ? 'date' : undefined}>
              <td><time dateTime={day.date}>{formatHolidayDate(day.date)}</time>{day.date === localDate && <small>TODAY</small>}</td>
              <td><a href={publication!.sources[day.source].url} target="_blank" rel="noreferrer">{day.name.toUpperCase()}</a>
                {day.status === 'scheduled' && <small>SCHEDULED</small>}
                {day.observedFor && <small>OBSERVED FOR {formatHolidayDate(day.observedFor)}</small>}
                {day.note && <small>{day.note}</small>}
              </td>
            </tr>)}</tbody>
          </table>}
          {publication && <footer><h3>OFFICIAL SOURCES</h3><ul>{Object.entries(publication.sources).map(([id, item]) =>
            <li key={id}><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></li>)}</ul></footer>}
        </> : <p role="status">OFFICIAL HOLIDAY DATES NOT YET AVAILABLE.</p>}
      </div>
    </Modal>}
  </>;
}
