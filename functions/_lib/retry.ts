export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  maxAttempts = 2,
  onAttempt?: (attempt: number) => Promise<void> | void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await onAttempt?.(attempt);
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
