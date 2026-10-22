import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from './csv.mjs'

test('plain rows', () => assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]))
test('trailing newline adds no row', () => assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]))
test('CRLF', () => assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]))
test('empty fields', () => assert.deepEqual(parseCsv('a,,c\n,,'), [['a', '', 'c'], ['', '', '']]))
test('quoted comma', () => assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]))
test('escaped quote', () => assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', 'x']]))
test('newline inside quotes', () => assert.deepEqual(parseCsv('"a\nb",c\nd,e'), [['a\nb', 'c'], ['d', 'e']]))
test('CRLF inside quotes is kept', () => assert.deepEqual(parseCsv('"a\r\nb",c'), [['a\r\nb', 'c']]))
test('spaces are kept', () => assert.deepEqual(parseCsv(' a , b '), [[' a ', ' b ']]))
test('empty quoted field', () => assert.deepEqual(parseCsv('"",x'), [['', 'x']]))
test('quoted field then end of input', () => assert.deepEqual(parseCsv('x,"y"'), [['x', 'y']]))
test('empty input has no rows', () => assert.deepEqual(parseCsv(''), []))
test('a blank line in the middle is a row with one empty field', () => assert.deepEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']]))
test('unterminated quote throws', () => assert.throws(() => parseCsv('"abc'), /quote/i))
test('quote in the middle of an unquoted field is literal', () => assert.deepEqual(parseCsv('ab"c,d'), [['ab"c', 'd']]))
