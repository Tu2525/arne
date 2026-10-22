import { DEFAULTS } from './defaults.mjs'

// Returns a description of the button with the given options applied over the defaults.
export function render(opts = {}) {
  const cfg = Object.assign(DEFAULTS, opts)
  return `${cfg.color}-${cfg.size}${cfg.retina ? '@2x' : ''}`
}
