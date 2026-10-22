// LRU cache with per-entry TTL. `now` is injected so tests can control time.
export class Cache {
  constructor({ max, ttl, now = Date.now }) {
    this.max = max
    this.ttl = ttl
    this.now = now
    this.map = new Map()
  }

  get(key) {
    const e = this.map.get(key)
    if (!e) return undefined
    if (this.now() - e.at > this.ttl) return undefined
    return e.value
  }

  set(key, value) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
    this.map.set(key, { value, at: this.now() })
  }

  has(key) {
    return this.map.has(key)
  }

  get size() {
    return this.map.size
  }
}
