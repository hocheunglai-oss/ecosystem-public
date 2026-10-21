/** Reviewed government publications, not a calculated or third-party calendar.
 * Refresh this snapshot when authorities publish a replacement/temporary holiday.
 * Dates are civil dates in the named jurisdiction; never parse them in the viewer's zone.
 */
export const HOLIDAYS_CHECKED_ON = '2026-10-20';
export type HolidayStatus = 'confirmed' | 'scheduled';
export interface PublicHoliday {
  date: string;
  name: string;
  source: string;
  observedFor?: string;
  note?: string;
  status?: HolidayStatus;
}
export interface HolidayYear {
  holidays: readonly PublicHoliday[];
  sources: Readonly<Record<string, { title: string; url: string }>>;
  notes?: readonly string[];
  pending?: readonly string[];
}
export interface CountryHolidayCalendar {
  country: string;
  code: string;
  timeZone: string;
  years: Readonly<Record<number, HolidayYear>>;
}
const source = (title: string, url: string) => ({ title, url });
// Each line is MM-DD | English holiday name | optional original date for a substitute.
function dates(year: number, text: string, sourceId = 'calendar'): PublicHoliday[] {
  return text.trim().split('\n').map(line => {
    const [day, name, original] = line.trim().split('|');
    return { date: `${year}-${day}`, name, source: sourceId, ...(original ? { observedFor: `${year}-${original}` } : {}) };
  });
}
const jp = source('CABINET OFFICE OF JAPAN', 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html');
const nl = source('GOVERNMENT OF THE NETHERLANDS', 'https://www.government.nl/themes/work/working-hours/question-and-answer/work/public-holidays-in-the-netherlands');
const kr2026 = source('KOREA AEROSPACE ADMINISTRATION · 2026', 'https://www.kasa.go.kr/prog/plcyBrf/brief/kor/sub01_01_04/view.do?plcyBrfNo=202');
const kr2027 = source('KOREA AEROSPACE ADMINISTRATION · 2027', 'https://www.kasa.go.kr/prog/plcyBrf/brief/kor/sub01_01_04/view.do?plcyBrfNo=431');
const vnLaw = source('GOVERNMENT OF VIETNAM · HOLIDAY DATES', 'https://xaydungchinhsach.chinhphu.vn/lich-nghi-le-gio-to-hung-vuong-30-4-1-5-quoc-khanh-2-9-nam-2026-119260222115822151.htm');
const vnCulture = source('GOVERNMENT OF VIETNAM · CULTURE DAY', 'https://xaydungchinhsach.chinhphu.vn/ngay-24-11-hang-nam-la-ngay-van-hoa-viet-nam-nguoi-lao-dong-duoc-nghi-huong-nguyen-luong-119260113152642414.htm');
const vn2027 = source('GOVERNMENT OF VIETNAM · 2027 ARRANGEMENTS', 'https://xaydungchinhsach.chinhphu.vn/de-xuat-2-phuong-an-nghi-tet-nguyen-dan-2027-tet-dinh-mui-11926080513033257.htm');
const ae = source('UAE GOVERNMENT · PUBLIC HOLIDAYS', 'https://u.ae/en/information-and-services/public-holidays-and-religious-affairs/public-holidays');
const vnNotes = ['TET AND THE ADJACENT NATIONAL DAY DATE FOLLOW THE PUBLISHED PUBLIC-SECTOR SCHEDULE. PRIVATE EMPLOYERS MAY SELECT ANOTHER PERMITTED ARRANGEMENT. WEEKLY REST DAYS ARE NOT LISTED.'];

export const publicHolidayCalendars: readonly CountryHolidayCalendar[] = [
  {
    country: 'Singapore', code: 'SG', timeZone: 'Asia/Singapore',
    years: {
      2026: {
        sources: { calendar: source('SINGAPORE MINISTRY OF MANPOWER · 2026', 'https://www.mom.gov.sg/newsroom/press-releases/2025/0616-public-holidays-for-2026') },
        holidays: dates(2026, `
01-01|New Year's Day
02-17|Chinese New Year
02-18|Chinese New Year
03-21|Hari Raya Puasa
04-03|Good Friday
05-01|Labour Day
05-27|Hari Raya Haji
05-31|Vesak Day
06-01|Vesak Day (observed)|05-31
08-09|National Day
08-10|National Day (observed)|08-09
11-08|Deepavali
11-09|Deepavali (observed)|11-08
12-25|Christmas Day`),
      },
      2027: {
        sources: { calendar: source('SINGAPORE MINISTRY OF MANPOWER · 2027', 'https://www.mom.gov.sg/newsroom/press-releases/2026/0618-public-holidays-for-2027') },
        holidays: dates(2027, `
01-01|New Year's Day
02-06|Chinese New Year
02-07|Chinese New Year
02-08|Chinese New Year (observed)|02-07
03-10|Hari Raya Puasa
03-26|Good Friday
05-01|Labour Day
05-17|Hari Raya Haji
05-20|Vesak Day
08-09|National Day
10-28|Deepavali
12-25|Christmas Day`),
      },
    },
  },
  {
    country: 'Hong Kong', code: 'HK', timeZone: 'Asia/Hong_Kong',
    years: {
      2026: {
        sources: { calendar: source('HONG KONG GOVERNMENT · 2026', 'https://www.info.gov.hk/gia/general/202505/16/P2025051300353.htm') },
        notes: ['NAMED GENERAL HOLIDAYS. SUNDAYS ARE ALSO GENERAL HOLIDAYS; THE EMPLOYMENT STATUTORY-HOLIDAY LIST DIFFERS.'],
        holidays: dates(2026, `
01-01|The first day of January
02-17|Lunar New Year's Day
02-18|The second day of Lunar New Year
02-19|The third day of Lunar New Year
04-03|Good Friday
04-04|The day following Good Friday
04-06|The day following Ching Ming Festival|04-05
04-07|The day following Easter Monday|04-06
05-01|Labour Day
05-25|The day following the Birthday of the Buddha|05-24
06-19|Tuen Ng Festival
07-01|Hong Kong SAR Establishment Day
09-26|The day following the Chinese Mid-Autumn Festival
10-01|National Day
10-19|The day following Chung Yeung Festival|10-18
12-25|Christmas Day
12-26|The first weekday after Christmas Day`),
      },
      2027: {
        sources: { calendar: source('HONG KONG GOVERNMENT · 2027', 'https://www.info.gov.hk/gia/general/202605/15/P2026051400304.htm') },
        notes: ['NAMED GENERAL HOLIDAYS. SUNDAYS ARE ALSO GENERAL HOLIDAYS; THE EMPLOYMENT STATUTORY-HOLIDAY LIST DIFFERS.'],
        holidays: dates(2027, `
01-01|The first day of January
02-06|Lunar New Year's Day
02-08|The third day of Lunar New Year
02-09|The fourth day of Lunar New Year|02-07
03-26|Good Friday
03-27|The day following Good Friday
03-29|Easter Monday
04-05|Ching Ming Festival
05-01|Labour Day
05-13|The Birthday of the Buddha
06-09|Tuen Ng Festival
07-01|Hong Kong SAR Establishment Day
09-16|The day following the Chinese Mid-Autumn Festival
10-01|National Day
10-08|Chung Yeung Festival
12-25|Christmas Day
12-27|The first weekday after Christmas Day`),
      },
    },
  },
  {
    country: 'Netherlands', code: 'NL', timeZone: 'Europe/Amsterdam',
    years: {
      2026: {
        sources: { calendar: nl },
        notes: ['A PUBLIC HOLIDAY DOES NOT AUTOMATICALLY ENTITLE EMPLOYEES TO A DAY OFF.'],
        holidays: dates(2026, `
01-01|New Year's Day
04-03|Good Friday
04-05|Easter Sunday
04-06|Easter Monday
04-27|King's Day
05-05|Liberation Day
05-14|Ascension Day
05-24|Whit Sunday
05-25|Whit Monday
12-25|Christmas Day
12-26|Boxing Day`),
      },
      2027: {
        sources: { calendar: nl },
        notes: ['A PUBLIC HOLIDAY DOES NOT AUTOMATICALLY ENTITLE EMPLOYEES TO A DAY OFF.'],
        holidays: dates(2027, `
01-01|New Year's Day
03-26|Good Friday
03-28|Easter Sunday
03-29|Easter Monday
04-27|King's Day
05-05|Liberation Day
05-06|Ascension Day
05-16|Whit Sunday
05-17|Whit Monday
12-25|Christmas Day
12-26|Boxing Day`),
      },
    },
  },
  {
    country: 'Japan', code: 'JP', timeZone: 'Asia/Tokyo',
    years: {
      2026: {
        sources: { calendar: jp },
        holidays: dates(2026, `
01-01|New Year's Day
01-12|Coming of Age Day
02-11|National Foundation Day
02-23|Emperor's Birthday
03-20|Vernal Equinox Day
04-29|Showa Day
05-03|Constitution Memorial Day
05-04|Greenery Day
05-05|Children's Day
05-06|Substitute holiday|05-03
07-20|Marine Day
08-11|Mountain Day
09-21|Respect for the Aged Day
09-22|Citizens' holiday
09-23|Autumnal Equinox Day
10-12|Sports Day
11-03|Culture Day
11-23|Labour Thanksgiving Day`),
      },
      2027: {
        sources: { calendar: jp },
        holidays: dates(2027, `
01-01|New Year's Day
01-11|Coming of Age Day
02-11|National Foundation Day
02-23|Emperor's Birthday
03-21|Vernal Equinox Day
03-22|Substitute holiday|03-21
04-29|Showa Day
05-03|Constitution Memorial Day
05-04|Greenery Day
05-05|Children's Day
07-19|Marine Day
08-11|Mountain Day
09-20|Respect for the Aged Day
09-23|Autumnal Equinox Day
10-11|Sports Day
11-03|Culture Day
11-23|Labour Thanksgiving Day`),
      },
    },
  },
  {
    country: 'South Korea', code: 'KR', timeZone: 'Asia/Seoul',
    years: {
      2026: {
        sources: {
          calendar: kr2026, additions: kr2027,
          election: source('BUSAN GOVERNMENT · ELECTION DAY', 'https://museum.busan.go.kr/jeonggwan/jgboard/1732490'),
        },
        holidays: [
          ...dates(2026, `
01-01|New Year's Day
02-16|Seollal holiday
02-17|Seollal
02-18|Seollal holiday
03-01|Independence Movement Day
03-02|Independence Movement Day (observed)|03-01
05-05|Children's Day
05-24|Buddha's Birthday
05-25|Buddha's Birthday (observed)|05-24
06-06|Memorial Day
08-15|Liberation Day
08-17|Liberation Day (observed)|08-15
09-24|Chuseok holiday
09-25|Chuseok
09-26|Chuseok holiday
10-03|National Foundation Day
10-05|National Foundation Day (observed)|10-03
10-09|Hangeul Day
12-25|Christmas Day`),
          ...dates(2026, `05-01|Labour Day\n07-17|Constitution Day`, 'additions'),
          ...dates(2026, `06-03|Local election day`, 'election'),
        ],
      },
      2027: {
        sources: {
          calendar: kr2027,
          buddha: source('BUSAN GOVERNMENT · MAY 2027', 'https://lll.geumjeong.go.kr/schedule/list.geumj?boardId=BBS_0000139&menuCd=DOM_000000612001000000&paging=ok&searchStartDt=2027-05&startPage=1'),
        },
        holidays: [
          ...dates(2027, `
01-01|New Year's Day
02-06|Seollal holiday
02-07|Seollal
02-08|Seollal holiday
02-09|Seollal (observed)|02-07
03-01|Independence Movement Day
05-01|Labour Day
05-03|Labour Day (observed)|05-01
05-05|Children's Day
06-06|Memorial Day
07-17|Constitution Day
07-19|Constitution Day (observed)|07-17
08-15|Liberation Day
08-16|Liberation Day (observed)|08-15
09-14|Chuseok holiday
09-15|Chuseok
09-16|Chuseok holiday
10-03|National Foundation Day
10-04|National Foundation Day (observed)|10-03
10-09|Hangeul Day
10-11|Hangeul Day (observed)|10-09
12-25|Christmas Day
12-27|Christmas Day (observed)|12-25`),
          ...dates(2027, '05-13|Buddha\'s Birthday', 'buddha'),
        ],
      },
    },
  },
  {
    country: 'Gibraltar', code: 'GI', timeZone: 'Europe/Gibraltar',
    years: {
      2026: {
        sources: { calendar: source('HM GOVERNMENT OF GIBRALTAR · 2026', 'https://www.gibraltar.gov.gi/press-releases/bank-holidays-2026-11299') },
        holidays: dates(2026, `
01-01|New Year's Day
02-16|Winter Midterm Bank Holiday
04-03|Good Friday
04-06|Easter Monday
04-28|Workers' Memorial Day
05-01|May Day
05-25|Spring Bank Holiday
06-15|King's Birthday
08-31|Late Summer Bank Holiday
09-10|Gibraltar National Day
12-25|Christmas Day
12-28|Boxing Day (observed)|12-26`).map(day => day.date === '2026-06-15' ? { ...day, status: 'scheduled', note: 'SUBJECT TO CHANGE IN THE GOVERNMENT NOTICE.' } : day),
      },
      2027: {
        sources: { calendar: source('HM GOVERNMENT OF GIBRALTAR · 2027', 'https://www.gibraltar.gov.gi/press-releases/bank-and-public-holidays-2027-12410') },
        pending: ["KING'S BIRTHDAY — DATE TO BE CONFIRMED."],
        holidays: dates(2027, `
01-01|New Year's Day
02-15|Winter Midterm Bank Holiday
03-26|Good Friday
03-29|Easter Monday
04-28|Workers' Memorial Day
05-03|May Day
05-31|Spring Bank Holiday
08-30|Late Summer Bank Holiday
09-10|Gibraltar National Day
12-27|Christmas Day (observed)|12-25
12-28|Boxing Day (observed)|12-26`),
      },
    },
  },
  {
    country: 'United Arab Emirates', code: 'AE', timeZone: 'Asia/Dubai',
    years: {
      2026: {
        sources: {
          calendar: ae,
          fitr: source('UAE PRESIDENTIAL COURT · EID AL FITR', 'https://www.wam.ae/en/article/bz9l2ze-breaking-thursday-completes-ramadan-friday-marks'),
          adha: source('UAE MOHRE · ARAFAT DAY AND EID AL ADHA', 'https://www.wam.ae/en/article/c09wibx-uae-announces-may-26-29-eid-adha-holiday-for'),
          hijri: source('UAE MOHRE · HIJRI NEW YEAR', 'https://www.linkedin.com/posts/mohre_%D9%88%D8%B2%D8%A7%D8%B1%D8%A9%D8%A7%D9%84%D9%85%D9%88%D8%A7%D8%B1%D8%AF%D8%A7%D9%84%D8%A8%D8%B4%D8%B1%D9%8A%D8%A9%D9%88%D8%A7%D9%84%D8%AA%D9%88%D8%B7%D9%8A%D9%86-%D8%A7%D9%84%D8%A5%D9%85%D8%A7%D8%B1%D8%A7%D8%AA-activity-7467970240249880576-QeWD'),
          prophet: source('UAE FAHR · PROPHET\'S BIRTHDAY', 'https://www.fahr.gov.ae/wp-content/uploads/2026/08/Circular-No.-11-of-2026-Regarding-The-Holiday-of-the-Prophet-Mohammads-Birthday-1448-AH.pdf'),
        },
        notes: ['NATIONAL DAY DATES ARE SCHEDULED UNDER THE OFFICIAL CALENDAR; LATER CABINET ANNOUNCEMENTS MAY TRANSFER THEM. SECTOR-SPECIFIC ARRANGEMENTS ARE LABELLED.'],
        holidays: [
          ...dates(2026, "01-01|New Year's Day"),
          ...dates(2026, '03-19|Eid Al Fitr holiday\n03-20|Eid Al Fitr\n03-21|Eid Al Fitr holiday\n03-22|Eid Al Fitr holiday', 'fitr'),
          ...dates(2026, '05-26|Arafat Day\n05-27|Eid Al Adha\n05-28|Eid Al Adha holiday\n05-29|Eid Al Adha holiday', 'adha'),
          ...dates(2026, '06-15|Hijri New Year', 'hijri'),
          { date: '2026-08-28', name: "Prophet Mohammad's Birthday", source: 'prophet', note: 'FEDERAL GOVERNMENT SCHEDULE.' },
          ...dates(2026, '12-02|National Day\n12-03|National Day').map(day => ({ ...day, status: 'scheduled' as const })),
        ],
      },
      2027: {
        sources: { calendar: ae },
        pending: ['EID AL FITR, ARAFAT DAY, EID AL ADHA, HIJRI NEW YEAR AND THE PROPHET\'S BIRTHDAY — GREGORIAN HOLIDAY DATES AWAIT OFFICIAL CONFIRMATION.'],
        notes: ['FIXED DATES FROM THE OFFICIAL CALENDAR. LATER CABINET ANNOUNCEMENTS MAY TRANSFER NON-EID HOLIDAYS.'],
        holidays: dates(2027, "01-01|New Year's Day\n12-02|National Day\n12-03|National Day").map(day => ({ ...day, status: 'scheduled' as const })),
      },
    },
  },
  {
    country: 'Vietnam', code: 'VN', timeZone: 'Asia/Ho_Chi_Minh',
    years: {
      2026: {
        sources: {
          calendar: vnLaw, culture: vnCulture,
          tet: source('GOVERNMENT OF VIETNAM · 2026 TET SCHEDULE', 'https://xaydungchinhsach.chinhphu.vn/lich-nghi-tet-am-lich-nghi-le-quoc-khanh-2026-cua-can-bo-cong-chuc-vien-chuc-nguoi-lao-dong-thanh-pho-ha-noi-119251024164121427.htm'),
          national: source('GOVERNMENT OF VIETNAM · 2026 NATIONAL DAY', 'https://xaydungchinhsach.chinhphu.vn/thong-bao-lich-nghi-le-quoc-khanh-2026-119260729092042494.htm'),
          newyear: source('GOVERNMENT OF VIETNAM · 2026 NEW YEAR', 'https://xaydungchinhsach.chinhphu.vn/nghi-tet-duong-lich-bo-tri-nhan-luc-ho-tro-doanh-nghiep-bao-dam-xuat-nhap-khau-khong-bi-gian-doan-119251228232748064.htm'),
        },
        notes: vnNotes,
        holidays: [
          ...dates(2026, "01-01|New Year's Day\n04-26|Hung Kings Commemoration Day\n04-27|Hung Kings Commemoration Day (observed)|04-26\n04-30|Reunification Day\n05-01|International Labour Day"),
          { date: '2026-01-02', name: "New Year's bridge day", source: 'newyear', note: 'PUBLIC-SECTOR WORKDAY SWAP; WORKED ON 10 JANUARY.' },
          ...dates(2026, '02-16|Tet holiday\n02-17|Tet\n02-18|Tet holiday\n02-19|Tet holiday\n02-20|Tet holiday', 'tet').map(day => ({ ...day, note: 'PUBLIC-SECTOR SCHEDULE.' })),
          ...dates(2026, '08-31|National Day bridge day\n09-01|National Day holiday\n09-02|National Day', 'national').map(day => ({ ...day, note: day.date === '2026-08-31' ? 'PUBLIC-SECTOR WORKDAY SWAP; WORKED ON 22 AUGUST.' : day.date === '2026-09-01' ? 'PUBLIC-SECTOR SCHEDULE; PRIVATE EMPLOYERS MAY CHOOSE 3 SEPTEMBER.' : undefined })),
          ...dates(2026, '11-24|Vietnam Culture Day', 'culture'),
        ],
      },
      2027: {
        sources: {
          calendar: vnLaw, culture: vnCulture, arrangements: vn2027,
          dates: source('HO CHI MINH CITY GOVERNMENT PRESS CENTRE · 2027', 'https://ttbc-hcm.gov.vn/thong-tin-bao-chi-14-10-nguoi-lao-dong-co-22-ngay-nghi-le-nam-2027-mua-mua-o-tp-hcm-va-nam-bo-du-kien-ket-thuc-vao-nua-dau-thang-11-1022434.html'),
        },
        notes: vnNotes,
        holidays: [
          ...dates(2027, "01-01|New Year's Day\n04-30|Reunification Day\n05-01|International Labour Day"),
          ...dates(2027, '04-16|Hung Kings Commemoration Day\n05-03|International Labour Day (observed)|05-01', 'dates').map(day => ({ ...day, ...(day.observedFor ? { note: 'FOR A SATURDAY/SUNDAY WEEKLY REST SCHEDULE.' } : {}) })),
          ...dates(2027, '02-04|Tet holiday\n02-05|Tet holiday\n02-06|Tet\n02-07|Tet holiday\n02-08|Tet holiday\n02-09|Tet holiday (observed)|02-06\n02-10|Tet holiday (observed)|02-07', 'arrangements').map(day => ({ ...day, note: 'PUBLIC-SECTOR SCHEDULE.' })),
          ...dates(2027, '09-02|National Day\n09-03|National Day holiday', 'arrangements').map(day => ({ ...day, ...(day.date === '2027-09-03' ? { note: 'PUBLIC-SECTOR SCHEDULE; PRIVATE EMPLOYERS MAY CHOOSE 1 SEPTEMBER.' } : {}) })),
          ...dates(2027, '11-24|Vietnam Culture Day', 'culture'),
        ],
      },
    },
  },
];

/** Explicit current jurisdiction names only: do not infer from substrings/ports. */
export function publicHolidayCalendar(country: string): CountryHolidayCalendar | undefined {
  const name = country.trim().toLocaleLowerCase('en');
  return publicHolidayCalendars.find(calendar => calendar.country.toLocaleLowerCase('en') === name);
}
export function holidayLocalDate(now: Date, timeZone: string): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch { return null; }
}
export function holidayDates(calendar: CountryHolidayCalendar, year: number): readonly PublicHoliday[] {
  return [...(calendar.years[year]?.holidays ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
export function nextPublicHoliday(calendar: CountryHolidayCalendar, localDate: string, includeToday = true): PublicHoliday | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return undefined;
  return Object.values(calendar.years).flatMap(year => year.holidays)
    .filter(day => includeToday ? day.date >= localDate : day.date > localDate)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
}

export type TodayPublicHoliday = { kind: 'holiday'; holidays: readonly PublicHoliday[] } | { kind: 'nonholiday' | 'unconfirmed' | 'unavailable' };

function publicationComplete(publication: HolidayYear | undefined): boolean {
  // A pending/movable date or employer-dependent schedule cannot prove absence.
  return Boolean(publication && !publication.pending?.length && !publication.holidays.some(day => day.status === 'scheduled') &&
    !publication.notes?.some(note => note.includes('PRIVATE EMPLOYERS')));
}

export function todayPublicHoliday(calendar: CountryHolidayCalendar | undefined, localDate: string | null): TodayPublicHoliday {
  if (!calendar || !localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return { kind: 'unavailable' };
  const civilDate = new Date(`${localDate}T12:00:00Z`);
  if (!Number.isFinite(civilDate.getTime()) || civilDate.toISOString().slice(0, 10) !== localDate) return { kind: 'unavailable' };
  const publication = calendar.years[Number(localDate.slice(0, 4))];
  if (!publication) return { kind: 'unavailable' };
  const holidays = publication.holidays.filter(day => day.date === localDate && day.status !== 'scheduled');
  if (holidays.length) return { kind: 'holiday', holidays };
  // The existing Hong Kong publication lists named holidays and explicitly notes
  // recurring Sundays separately. An absent named row cannot negate a Sunday.
  if (!publicationComplete(publication) || calendar.code === 'HK' && civilDate.getUTCDay() === 0) return { kind: 'unconfirmed' };
  return { kind: 'nonholiday' };
}

/** Missing years or unconfirmed dates may precede the next published entry. */
export function nextHolidayIsComplete(calendar: CountryHolidayCalendar, localDate: string, next: PublicHoliday): boolean {
  if (calendar.code === 'HK') return false;
  for (let year = Number(localDate.slice(0, 4)); year <= Number(next.date.slice(0, 4)); year++) {
    if (!publicationComplete(calendar.years[year])) return false;
  }
  return true;
}
export function formatHolidayDate(date: string, includeYear = false): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)).toUpperCase();
}
