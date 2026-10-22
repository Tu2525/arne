export function parseCsv(text) {
  const rows = []
  let row = [], f = '', i = 0, q = false, any = false
  while (i < text.length) {
    const c = text[i]
    any = true
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue } q = false; i++; continue }
      f += c; i++; continue
    }
    if (c === '"' && f === '') { q = true; i++; continue }
    if (c === ',') { row.push(f); f = ''; i++; continue }
    if (c === '\r' && text[i + 1] === '\n') i++
    if (c === '\n' || c === '\r') { row.push(f); rows.push(row); row = []; f = ''; any = false; i++; continue }
    f += c; i++
  }
  if (q) throw new Error('unterminated quote')
  if (any) { row.push(f); rows.push(row) }
  return rows
}
