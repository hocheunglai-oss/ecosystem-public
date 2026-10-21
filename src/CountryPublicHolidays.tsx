import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Modal } from './ui';
import { HOLIDAYS_CHECKED_ON, formatHolidayDate, holidayDates, holidayLocalDate, nextPublicHoliday, publicHolidayCalendar } from './lib/publicHolidays';
import './public-holidays.css';

export default function CountryPublicHolidays({ country, timezone }: { country: string; timezone?: string }) {
  return <HolidayCalendar key={`${country}:${timezone ?? ''}`} country={country} timezone={timezone} />;
}

function HolidayCalendar({ country, timezone }: { country: string; timezone?: string }) {
  const calendar = publicHolidayCalendar(country);
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const localDate = calendar ? (timezone && holidayLocalDate(now, timezone)) || holidayLocalDate(now, calendar.timeZone) : null;
  const currentYear = localDate ? Number(localDate.slice(0, 4)) : now.getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const next = calendar && localDate ? nextPublicHoliday(calendar, localDate) : undefined;
  const publication = calendar?.years[year];
  const years = [...new Set([currentYear, ...Object.keys(calendar?.years ?? {}).map(Number)])].sort();
  const days = calendar ? holidayDates(calendar, year) : [];
  const partialNext = calendar && localDate && Object.entries(calendar.years).some(([publishedYear, data]) =>
    Number(publishedYear) >= currentYear && Number(publishedYear) <= Number(next?.date.slice(0, 4) ?? currentYear) && data.pending?.length);
  return <>
    <button type="button" className="button secondary public-holidays-trigger" aria-label="Public holidays" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setYear(currentYear); setOpen(true); }}>
      <CalendarDays size={16} aria-hidden="true" />
      <span>PUBLIC HOLIDAYS{next ? <> · {next.date === localDate ? 'TODAY' : partialNext ? 'NEXT PUBLISHED' : 'NEXT'}: {formatHolidayDate(next.date, next.date.slice(0, 4) !== String(currentYear))} · {next.name.toUpperCase()}{next.status === 'scheduled' ? ' (SCHEDULED)' : ''}</> : ' · DATES UNAVAILABLE'}</span>
    </button>
    {open && <Modal title="PUBLIC HOLIDAYS" kicker={country.toUpperCase()} onClose={() => setOpen(false)}>
      <div className="public-holidays">
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
