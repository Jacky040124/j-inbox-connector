// Bun wrapper serving a FakeGoogle on 127.0.0.1 (OAuth endpoints and the Gmail API on one origin).
import { FakeGoogle, type FakeGoogleOptions } from "./handler.ts";

export type RunningFakeGoogle = {
  readonly url: string;
  readonly port: number;
  readonly google: FakeGoogle;
  stop(): void;
};

export async function startFakeGoogle(opts: FakeGoogleOptions & { port?: number } = {}): Promise<RunningFakeGoogle> {
  const google = new FakeGoogle(opts);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch: async (req) => {
      try {
        return await google.fetch(req);
      } catch {
        // An injected network failure: drop the connection like a reset would.
        return new Response(null, { status: 502 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, google, stop: () => server.stop(true) };
}
