export const HOLIDAYS = ['2025-12-25', '2026-01-01', '2026-04-03']

export function isHoliday(d) {
  return HOLIDAYS.includes(d.toISOString().slice(0, 10))
}
