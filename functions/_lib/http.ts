// Nhost Functions receive Express-compatible request/response objects.  Keeping the
// tiny structural surface we use here avoids adding runtime/type-only dependencies
// to the Functions package.
export type Request = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
};

export type Response = {
  setHeader?(name: string, value: string): Response;
  header?(name: string, value: string): Response;
  status(code: number): Response;
  json(body: unknown): unknown;
};
