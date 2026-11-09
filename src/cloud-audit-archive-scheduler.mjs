function positiveInteger(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(name + ' is outside the supported range');
  }
}

export function createAuditArchiveScheduler({
  archiveBatch,
  batchLimit = 500,
  intervalMs = 60_000,
  maxBatchesPerRun = 10,
  onError = () => {},
} = {}) {
  if (typeof archiveBatch !== 'function') throw new TypeError('An audit archive batch function is required');
  positiveInteger(batchLimit, 1, 5000, 'batchLimit');
  positiveInteger(intervalMs, 1000, 24 * 60 * 60_000, 'intervalMs');
  positiveInteger(maxBatchesPerRun, 1, 100, 'maxBatchesPerRun');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');

  let timer = null;
  let inFlight = null;

  function runOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let batches = 0;
      let archived = 0;
      for (; batches < maxBatchesPerRun; batches++) {
        const result = await archiveBatch({ limit: batchLimit });
        if (!result || !Number.isSafeInteger(result.archived) || result.archived < 0 ||
            result.archived > batchLimit) {
          throw new Error('Audit archive batch returned an invalid archived count');
        }
        archived += result.archived;
        if (result.archived === 0 || result.archived < batchLimit) {
          batches++;
          break;
        }
      }
      return { batches, archived };
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function tick() {
    try { return await runOnce(); }
    catch (error) {
      try { onError(error); } catch {}
      return null;
    }
  }

  function start() {
    if (timer) return Object.freeze({ stop, runOnce, tick });
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    return Object.freeze({ stop, runOnce, tick });
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (inFlight) await inFlight;
  }

  return Object.freeze({ start, stop, runOnce, tick, get running() { return timer !== null; } });
}
