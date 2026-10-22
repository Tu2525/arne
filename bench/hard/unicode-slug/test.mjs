import test from 'node:test'
import assert from 'node:assert/strict'
import { slug } from './slug.mjs'
import { exportName } from './export.mjs'

test('plain title', () => assert.equal(slug('Hello World'), 'hello-world'))
test('accents are folded to letters', () => assert.equal(slug('Café Déjà Vu'), 'cafe-deja-vu'))
test('punctuation collapses', () => assert.equal(slug('  Q&A: what?  '), 'q-a-what'))
test('export file name uses the slug', () => assert.equal(exportName('2026-03-01', 'Crème brûlée'), '2026-03-note-creme-brulee.md'))
