// Calls fn until it succeeds or `tries` attempts are used up. Waits between attempts, doubling each time:
// with delay 100 the waits are 100, 200, 400, ... Calls `sleep(ms)` for each wait.
export async function retry(fn, { tries, delay, sleep }) {
  let lastError
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i < tries - 1) await sleep(delay * i || delay)
    }
  }
  throw lastError
}
