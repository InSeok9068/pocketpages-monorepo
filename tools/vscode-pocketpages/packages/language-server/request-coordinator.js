"use strict";

function createRequestCoordinator(options = {}) {
  const runtimeState = options.runtimeState || null;
  const setTimer =
    typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer =
    typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const timers = new Map();

  function toTimerKey(uri, key) {
    return `${String(uri || "")}::${String(key || "default")}`;
  }

  function cancel(uri, key = null) {
    const uriPrefix = `${String(uri || "")}::`;
    for (const timerKey of [...timers.keys()]) {
      if (key !== null && timerKey !== toTimerKey(uri, key)) {
        continue;
      }

      if (key === null && !timerKey.startsWith(uriPrefix)) {
        continue;
      }

      clearTimer(timers.get(timerKey));
      timers.delete(timerKey);
    }
  }

  function schedule(optionsOrUri, maybeKey, maybeDelayMs, maybeCallback) {
    const request =
      typeof optionsOrUri === "object" && optionsOrUri !== null
        ? optionsOrUri
        : {
            uri: optionsOrUri,
            key: maybeKey,
            delayMs: maybeDelayMs,
          };
    const callback =
      typeof optionsOrUri === "object" && optionsOrUri !== null
        ? maybeKey
        : maybeCallback;

    const uri = String(request.uri || "");
    const key = String(request.key || "default");
    const version = request.version;
    const timerKey = toTimerKey(uri, key);
    const delayMs = Math.max(0, Number(request.delayMs) || 0);

    cancel(uri, key);

    const timeoutId = setTimer(() => {
      timers.delete(timerKey);
      if (
        version !== undefined &&
        runtimeState &&
        typeof runtimeState.isStaleVersion === "function" &&
        runtimeState.isStaleVersion(uri, version)
      ) {
        return;
      }

      if (typeof callback === "function") {
        callback();
      }
    }, delayMs);

    timers.set(timerKey, timeoutId);
    return timeoutId;
  }

  function hasScheduled(uri, key) {
    return timers.has(toTimerKey(uri, key));
  }

  return {
    schedule,
    cancel,
    hasScheduled,
  };
}

module.exports = {
  createRequestCoordinator,
};
