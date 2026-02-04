/**
 * Debounce utility function
 */

/**
 * Creates a debounced version of a function that delays invoking the function
 * until after `wait` milliseconds have elapsed since the last time the debounced
 * function was invoked.
 *
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay
 * @returns A debounced version of the function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (this: unknown, ...args: Parameters<T>) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      func.apply(this, args);
    }, wait);
  };
}

/**
 * Creates a debounced version of a function with a leading edge call.
 * The function is invoked immediately on the first call, then subsequent calls
 * are debounced.
 *
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay
 * @returns A debounced version of the function with leading edge
 */
export function debounceLeading<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastCallTime = 0;

  return function (this: unknown, ...args: Parameters<T>) {
    const now = Date.now();

    if (now - lastCallTime >= wait) {
      // Enough time has passed, invoke immediately
      lastCallTime = now;
      func.apply(this, args);
    } else {
      // Debounce the call
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(
        () => {
          timeoutId = null;
          lastCallTime = Date.now();
          func.apply(this, args);
        },
        wait - (now - lastCallTime),
      );
    }
  };
}

/**
 * Creates a throttled version of a function that only invokes the function
 * at most once per `wait` milliseconds.
 *
 * @param func The function to throttle
 * @param wait The number of milliseconds to throttle by
 * @returns A throttled version of the function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let lastCallTime = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (this: unknown, ...args: Parameters<T>) {
    const now = Date.now();
    const remaining = wait - (now - lastCallTime);

    if (remaining <= 0 || remaining > wait) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCallTime = now;
      func.apply(this, args);
    } else if (timeoutId === null) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        lastCallTime = Date.now();
        func.apply(this, args);
      }, remaining);
    }
  };
}
