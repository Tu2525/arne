import { isHoliday } from './holidays.mjs'

export const isBusinessDay = d => d.getDay() !== 0 && d.getDay() !== 6 && !isHoliday(d)

// Moves `date` by n business days (n may be negative) and returns a new Date.
export function addBusinessDays(date, n) {
  const d = new Date(date)
  let left = n
  while (left !== 0) {
    d.setDate(d.getDate() + (n > 0 ? 1 : -1))
    if (isBusinessDay(d)) left -= Math.sign(n)
  }
  return d
}
