export const env = (((globalThis as any).process?.env ?? {}) as Record<string, string | undefined>);
