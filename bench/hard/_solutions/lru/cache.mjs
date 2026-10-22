export class Cache {
  constructor({ max, ttl, now = Date.now }) { this.max = max; this.ttl = ttl; this.now = now; this.map = new Map() }
  #live(e) { return this.now() - e.at <= this.ttl }
  #purge() { for (const [k, e] of this.map) if (!this.#live(e)) this.map.delete(k) }
  get(key) {
    const e = this.map.get(key)
    if (!e) return undefined
    if (!this.#live(e)) { this.map.delete(key); return undefined }
    this.map.delete(key); this.map.set(key, e)
    return e.value
  }
  set(key, value) {
    this.map.delete(key)
    this.#purge()
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value)
    this.map.set(key, { value, at: this.now() })
  }
  has(key) { const e = this.map.get(key); if (!e) return false; if (!this.#live(e)) { this.map.delete(key); return false } return true }
  delete(key) { return this.has(key) && this.map.delete(key) }
  get size() { this.#purge(); return this.map.size }
}
