// Lets node load the plugin's TypeScript, which imports siblings without an extension: node --import ./bench/router/ts-resolve.mjs --experimental-strip-types
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (s.startsWith('.')) return next(s + '.ts', c); throw e } }`))
