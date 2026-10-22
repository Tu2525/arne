import { slug } from './slug.mjs'

// Export file names look like "2026-03-note-cafe-deja.md".
export function exportName(date, title) {
  return `${date.slice(0, 7)}-note-${slug(title)}.md`
}
