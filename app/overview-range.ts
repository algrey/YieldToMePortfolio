export function subtractCalendarMonths(date: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const targetIndex = year * 12 + month - months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth = targetIndex % 12;
  const daysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, daysInTargetMonth)).padStart(2, "0")}`;
}
