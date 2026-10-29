// A protocol-only fake of TypeSafe's System One for the connector's tests (testkit is closed source,
// so the connector cannot use its fake-jev): an injectable fetch that checks the request like the
// real service, records it, and answers each question with `decide(conversation, choices)`.
export const TEST_JEV_KEY = "ts_test_key_0123456789abcdef";
export const TEST_JEV_URL = "https://jev.test";

export type Conversation = Record<string, any>;
export type Decide = (conv: Conversation, criteria: Record<string, string>) => { choice: string; confidence: number };
type Fault = number | "network" | "hang" | "garbage";

/** The noise line whose description contains `word`, at `confidence`. */
export const pickLine = (criteria: Record<string, string>, word: RegExp, confidence = 0.9) => {
  const name = Object.keys(criteria).find((k) => k !== "Not noise" && word.test(criteria[k]!));
  return name ? { choice: name, confidence } : { choice: "Not noise", confidence: 0.95 };
};

export function fakeJev(decide: Decide) {
  const requests: { url: string; auth: string | null; contentType: string | null; body: any }[] = [];
  const faults: Fault[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.json().catch(() => null);
    requests.push({ url: req.url, auth: req.headers.get("authorization"), contentType: req.headers.get("content-type"), body });
    const f = faults.shift();
    if (f === "network") throw new TypeError("fetch failed");
    if (f === "hang")
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    if (f === "garbage") return new Response("<html>oops</html>", { status: 200 });
    if (typeof f === "number") return new Response(JSON.stringify({ error: { message: "injected" } }), { status: f });
    if (req.headers.get("authorization") !== `Bearer ${TEST_JEV_KEY}`) return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    if (!body || body.model !== "jev-latest" || typeof body.state !== "string" || typeof body.questions !== "object") return new Response("{}", { status: 400 });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      const i = q.instructions.indexOf("{");
      const conv = JSON.parse(q.instructions.slice(i));
      answers[id] = { ...decide(conv, q.criteria), probabilities: {} };
    }
    return new Response(JSON.stringify({ answers, usage: {}, model: "jev-test" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    failNext: (f: Fault) => faults.push(f),
    /** Every conversation asked about so far. */
    conversations: (): Conversation[] => requests.flatMap((r) => Object.values<any>(r.body?.questions ?? {}).map((q) => JSON.parse(q.instructions.slice(q.instructions.indexOf("{"))))),
  };
}
