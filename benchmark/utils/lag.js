let lastELUTime = Date.now();
/** @type {number|undefined} */
let maxLag;

const LOG_INTERVAL = 250;

const logEventLoopLag = () => {
  const tmpELUTime = Date.now();
  const timeDiff = tmpELUTime - lastELUTime;
  const lag = timeDiff - LOG_INTERVAL;

  lastELUTime = tmpELUTime;
  maxLag = (!maxLag || maxLag < lag) ? lag : maxLag;
};
const interval = setInterval(logEventLoopLag, LOG_INTERVAL);
interval.unref();

export const getAndResetMaxLag = () => {
  const result = maxLag;

  maxLag = 0;

  return result;
};
