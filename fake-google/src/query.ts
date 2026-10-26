// The subset of Gmail search syntax (support.google.com/mail/answer/7190) the fake understands:
// words and "quoted phrases" (subject, body, from), from: to: cc: subject:, in: is: label:
// category: has:attachment, after: before: (epoch seconds or yyyy/mm/dd), rfc822msgid:,
// -negation, {a b} and (a OR b) groups. Evaluated per message, like Gmail.

export type MessageView = {
  labelIds: string[];
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  internalDate: number;
  hasAttachment: boolean;
  messageIdHeader: string;
};

type Node = { kind: "term"; neg: boolean; key: string | null; value: string } | { kind: "or"; neg: boolean; items: Node[] } | { kind: "and"; neg: boolean; items: Node[] };

function tokenize(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("{}()".includes(c)) {
      out.push(c);
      i++;
      continue;
    }
    let j = i;
    let tok = "";
    while (j < q.length && !/\s/.test(q[j]!) && !"{}()".includes(q[j]!)) {
      if (q[j] === '"') {
        const end = q.indexOf('"', j + 1);
        const stop = end < 0 ? q.length : end;
        tok += q.slice(j, stop + 1);
        j = stop + 1;
      } else tok += q[j++];
    }
    out.push(tok);
    i = j;
  }
  return out;
}

function parseSeq(tokens: string[], pos: { i: number }, close: string | null, sawOr: { v: boolean } = { v: false }): Node[] {
  const items: Node[] = [];
  while (pos.i < tokens.length) {
    const t = tokens[pos.i]!;
    if (t === close) {
      pos.i++;
      return items;
    }
    pos.i++;
    if (t === "OR") {
      sawOr.v = true;
      continue;
    }
    let neg = false;
    let tok = t;
    if (tok === "-" && (tokens[pos.i] === "{" || tokens[pos.i] === "(")) {
      neg = true;
      tok = tokens[pos.i++]!;
    }
    if (tok === "{") items.push({ kind: "or", neg, items: parseSeq(tokens, pos, "}") });
    else if (tok === "(") {
      const or = { v: false };
      const inner = parseSeq(tokens, pos, ")", or);
      items.push(or.v ? { kind: "or", neg, items: inner } : { kind: "and", neg, items: inner });
    } else {
      if (tok.startsWith("-") && tok.length > 1) (neg = true), (tok = tok.slice(1));
      const m = /^([a-z_0-9]+):(.*)$/i.exec(tok);
      const unq = (v: string) => v.replace(/^"(.*)"$/, "$1");
      items.push(m ? { kind: "term", neg, key: m[1]!.toLowerCase(), value: unq(m[2]!).toLowerCase() } : { kind: "term", neg, key: null, value: unq(tok).toLowerCase() });
    }
  }
  return items;
}

const SYSTEM: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  spam: "SPAM",
  trash: "TRASH",
  starred: "STARRED",
  unread: "UNREAD",
  important: "IMPORTANT",
};

function dateArg(v: string): number | null {
  if (/^\d{1,12}$/.test(v)) return Number(v) * 1000;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function termMatches(t: Extract<Node, { kind: "term" }>, m: MessageView, self: string): boolean {
  const has = (l: string) => m.labelIds.includes(l);
  const v = t.value;
  switch (t.key) {
    case null: {
      const hay = `${m.subject}\n${m.text}\n${m.from}`.toLowerCase();
      return hay.includes(v);
    }
    case "from":
      return v === "me" ? m.from.toLowerCase().includes(self) : m.from.toLowerCase().includes(v);
    case "to":
      return v === "me" ? m.to.toLowerCase().includes(self) : m.to.toLowerCase().includes(v);
    case "cc":
      return m.cc.toLowerCase().includes(v);
    case "subject":
      return m.subject.toLowerCase().includes(v);
    case "in":
      if (v === "anywhere") return true;
      return has(SYSTEM[v] ?? v.toUpperCase());
    case "is":
      if (v === "read") return !has("UNREAD");
      return has(SYSTEM[v] ?? v.toUpperCase());
    case "label":
      return has(SYSTEM[v] ?? v.toUpperCase());
    case "category":
      // Like a real account with the Promotions and Social tabs on: Gmail's Primary tab also shows
      // Updates (and unlabelled) mail, so "primary" is "not promotions, social or forums".
      if (v === "primary") return !has("CATEGORY_PROMOTIONS") && !has("CATEGORY_SOCIAL") && !has("CATEGORY_FORUMS");
      return has(`CATEGORY_${v.toUpperCase()}`);
    case "has":
      return v === "attachment" ? m.hasAttachment : false;
    case "after": {
      const d = dateArg(v);
      return d !== null && m.internalDate > d;
    }
    case "before": {
      const d = dateArg(v);
      return d !== null && m.internalDate < d;
    }
    case "rfc822msgid":
      return m.messageIdHeader.toLowerCase().replace(/[<>]/g, "") === v.replace(/[<>]/g, "");
    default:
      return false;
  }
}

function evalNode(n: Node, m: MessageView, self: string): boolean {
  const r = n.kind === "term" ? termMatches(n, m, self) : n.kind === "or" ? n.items.some((x) => evalNode(x, m, self)) : n.items.every((x) => evalNode(x, m, self));
  return n.neg ? !r : r;
}

/** A predicate for one Gmail `q`. Empty or blank: everything. */
export function compileQuery(q: string | null | undefined, self: string): (m: MessageView) => boolean {
  if (!q || !q.trim()) return () => true;
  const nodes = parseSeq(tokenize(q), { i: 0 }, null);
  return (m) => nodes.every((n) => evalNode(n, m, self.toLowerCase()));
}
