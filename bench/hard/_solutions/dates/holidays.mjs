export const HOLIDAYS = ['2025-12-25', '2026-01-01', '2026-04-03']
const p = n => String(n).padStart(2, '0')
export function isHoliday(d) {
  return HOLIDAYS.includes(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
}
