// `j-inbox jev-key`: keep the TypeSafe (Jev) API key in the Keychain (`typesafe-api-key`), for noise.
// The key comes from stdin (`pbpaste | j-inbox jev-key`), or a hidden prompt in a terminal; it is
// never printed, logged or put in argv. `--delete` removes it (noise then judges nothing). The
// running service reads the key each time it asks Jev, so no restart is needed.
import { isStorableSecret } from "../secrets.ts";
import type { Ctx } from "./context.ts";

export async function jevKeyCommand(ctx: Ctx): Promise<number> {
  const { deps } = ctx;
  if (ctx.flags.delete) {
    await ctx.secrets.delete("typesafe-api-key");
    ctx.audit.lifecycle("jev.key_removed");
    deps.out("The Jev key is gone from this computer. Noise judges nothing until a key is set again.");
    return 0;
  }
  const key = deps.isTTY ? ((await deps.prompt.secret("Jev (TypeSafe) API key: ")) ?? "").trim() : (await deps.readStdin()).split(/\r?\n/)[0]!.trim();
  if (!key) {
    deps.err("No key given. Pipe it in (for example `pbpaste | j-inbox jev-key`).");
    return 1;
  }
  if (!isStorableSecret(key)) {
    deps.err("That does not look like an API key (letters, digits and . _ ~ + / = : - only, 8-4096 characters). Nothing was stored.");
    return 1;
  }
  await ctx.secrets.set("typesafe-api-key", key);
  ctx.audit.lifecycle("jev.key_set");
  deps.out("Jev key saved in this computer's Keychain. Conversations with new activity are judged once Settings > Noise has a definition.");
  return 0;
}
