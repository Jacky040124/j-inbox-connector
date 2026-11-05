// For the web's browser tests, which are not allowed to import the connector: the hostile corpus and the
// realistic emails as JSON, each as it came and as the real sanitizer leaves it (null: refused).
import { sanitizeEmailHtml } from "../../src/gmail/email-html.ts";
import { DARK_EMAILS } from "../fixtures/dark-emails.ts";
import { HOSTILE_EMAILS, LAYOUT_BOMBS, MARKETING_EMAIL, PROBE, REPLY_EMAIL } from "../fixtures/hostile-emails.ts";

const pair = (c: { name: string; html: string }) => ({ name: c.name, raw: c.html, clean: sanitizeEmailHtml(c.html) });
process.stdout.write(JSON.stringify({ probe: PROBE, hostile: HOSTILE_EMAILS.map(pair), bombs: LAYOUT_BOMBS.map(pair), marketing: pair({ name: "marketing", html: MARKETING_EMAIL }), reply: pair({ name: "reply", html: REPLY_EMAIL }), anchor: pair({ name: "anchor", html: `<p id="top"><a href="#bottom">To the end</a></p><p style="height:900px">words</p><p><a name="bottom" href="#top">Back up</a></p>` }), dark: Object.fromEntries(Object.entries(DARK_EMAILS).map(([name, html]) => [name, pair({ name, html })])) }));
