// `j-inbox logs`: recent operations (metadata only: what, when, ok/error). --service shows the
// service's own log (also metadata only).
import { readFileSync } from "node:fs";
import { AuditLog } from "../audit.ts";
import { UsageError, type Ctx } from "./context.ts";

export async function logsCommand(ctx: Ctx): Promise<number> {
  const raw = ctx.flags.n;
  const n = raw === undefined ? 50 : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) throw new UsageError("-n must be a number from 1 to 10000.");
  if (ctx.flags.service) {
    let text = "";
    try {
      text = readFileSync(ctx.paths.serviceLog, "utf8");
    } catch {}
    const lines = text.split("\n").filter(Boolean).slice(-n);
    if (!lines.length) ctx.deps.out(`No service log yet (${ctx.paths.serviceLog}).`);
    for (const l of lines) ctx.deps.out(l);
    return 0;
  }
  const entries = new AuditLog({ path: ctx.paths.auditFile }).tail(n);
  if (!entries.length) {
    ctx.deps.out("No activity recorded yet.");
    return 0;
  }
  for (const e of entries) {
    if (ctx.json) ctx.deps.out(JSON.stringify(e));
    else if (e.event === "request") {
      const who = e.caller ? `  by ${e.caller}${e.callerName ? ` ${e.callerName}` : ""}` : "";
      ctx.deps.out(`${e.ts}  ${(e.action ?? "").padEnd(16)} ${e.ok ? "ok" : `error ${e.code ?? ""}`}  ${e.ms ?? 0} ms${who}`);
    }
    else ctx.deps.out(`${e.ts}  ${e.event}${e.closeCode !== undefined ? ` (code ${e.closeCode})` : ""}`);
  }
  return 0;
}
