// Discord's date of birth input: three dropdowns (month, day, year) producing YYYY-MM-DD.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface DateParts {
  year: string;
  month: string; // "1".."12"
  day: string;
}

export const EMPTY_DATE: DateParts = { year: "", month: "", day: "" };

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(Number.isFinite(year) && year > 0 ? year : 2000, month, 0)).getUTCDate();
}

/** "YYYY-MM-DD", or "" while incomplete. */
export function isoDate({ year, month, day }: DateParts): string {
  if (!year || !month || !day) return "";
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function DateOfBirth({ value, onChange, invalid }: { value: DateParts; onChange(next: DateParts): void; invalid?: boolean }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 120 }, (_, i) => String(thisYear - 3 - i));
  const days = daysIn(Number(value.year), Number(value.month) || 1);
  const set = (patch: Partial<DateParts>) => {
    const next = { ...value, ...patch };
    // drop a day that the new month or year does not have (Feb 30)
    if (next.day && Number(next.day) > daysIn(Number(next.year), Number(next.month) || 1)) next.day = "";
    onChange(next);
  };
  return (
    <div className={`auth-dob${invalid ? " invalid" : ""}`}>
      <select className="input auth-select" aria-label="Month" value={value.month} onChange={e => set({ month: e.target.value })}>
        <option value="" disabled>
          Month
        </option>
        {MONTHS.map((name, i) => (
          <option key={name} value={String(i + 1)}>
            {name}
          </option>
        ))}
      </select>
      <select className="input auth-select" aria-label="Day" value={value.day} onChange={e => set({ day: e.target.value })}>
        <option value="" disabled>
          Day
        </option>
        {Array.from({ length: days }, (_, i) => String(i + 1)).map(d => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <select className="input auth-select" aria-label="Year" value={value.year} onChange={e => set({ year: e.target.value })}>
        <option value="" disabled>
          Year
        </option>
        {years.map(y => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
