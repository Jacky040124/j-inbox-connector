// A tiny dependency-free runtime validator. Works in Workers, Bun and browsers.
// Every schema is strict: objects reject unknown keys, strings and arrays are bounded.

export type Path = (string | number)[];
export type Issue = { path: Path; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

const MAX_ISSUES = 20;
const INVALID: unique symbol = Symbol("invalid");
type Invalid = typeof INVALID;

class Ctx {
  issues: Issue[] = [];
  add(path: Path, message: string) {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path: [...path], message });
  }
  get full() {
    return this.issues.length >= MAX_ISSUES;
  }
}

/** Describes a schema for docs and Raft manifest generation. */
export type Meta =
  | { type: "string"; min: number; max: number; multiline: boolean; format?: string }
  | { type: "integer"; min: number; max: number }
  | { type: "boolean" }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "enum"; values: readonly string[] }
  | { type: "array"; item: Meta; min: number; max: number }
  | { type: "object"; shape: Record<string, Meta>; optional: string[] }
  | { type: "record"; value: Meta; max: number }
  | { type: "nullable"; inner: Meta }
  | { type: "union"; key: string; variants: Record<string, Meta> }
  | { type: "json" };

export interface Schema<T> {
  readonly meta: Meta;
  readonly isOptional: boolean;
  /** @internal */
  _check(input: unknown, path: Path, ctx: Ctx): T | Invalid;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional: true;
}

function make<T>(meta: Meta, check: (input: unknown, path: Path, ctx: Ctx) => T | Invalid): Schema<T> {
  return { meta, isOptional: false, _check: check };
}

export function parse<T>(schema: Schema<T>, input: unknown): Result<T> {
  const ctx = new Ctx();
  const value = schema._check(input, [], ctx);
  if (value === INVALID || ctx.issues.length) {
    if (!ctx.issues.length) ctx.add([], "invalid value");
    return { ok: false, issues: ctx.issues };
  }
  return { ok: true, value };
}

export function is<T>(schema: Schema<T>, input: unknown): input is T {
  return parse(schema, input).ok;
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
}

const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// Disallowed in single-line strings: all C0/C1 controls and DEL.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Disallowed in multi-line text: C0 controls except \t \n \r, DEL and C1.
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type StringOpts = { min?: number; max: number; pattern?: RegExp; format?: string };

function stringCheck(opts: StringOpts & { multiline: boolean }) {
  const min = opts.min ?? 0;
  return (input: unknown, path: Path, ctx: Ctx): string | Invalid => {
    if (typeof input !== "string") return ctx.add(path, `expected string, got ${typeName(input)}`), INVALID;
    if (input.length > opts.max) return ctx.add(path, `must be at most ${opts.max} characters`), INVALID;
    if (input.length < min) return ctx.add(path, `must be at least ${min} characters`), INVALID;
    if ((opts.multiline ? TEXT_CONTROL_RE : CONTROL_RE).test(input)) return ctx.add(path, "contains control characters"), INVALID;
    if (LONE_SURROGATE_RE.test(input)) return ctx.add(path, "contains invalid unicode"), INVALID;
    if (opts.pattern && !opts.pattern.test(input)) return ctx.add(path, "has an invalid format"), INVALID;
    return input;
  };
}

/** Single-line string: no control characters at all. */
export function string(opts: StringOpts): Schema<string> {
  return make({ type: "string", min: opts.min ?? 0, max: opts.max, multiline: false, ...(opts.format ? { format: opts.format } : {}) }, stringCheck({ ...opts, multiline: false }));
}

/** Free text (message bodies, queries): allows \t \n \r. When min >= 1 it must not be whitespace-only. */
export function text(opts: { min?: number; max: number }): Schema<string> {
  const base = stringCheck({ ...opts, multiline: true });
  return make({ type: "string", min: opts.min ?? 0, max: opts.max, multiline: true }, (input, path, ctx) => {
    const v = base(input, path, ctx);
    if (v === INVALID) return v;
    if ((opts.min ?? 0) >= 1 && v.trim().length === 0) return ctx.add(path, "must not be blank"), INVALID;
    return v;
  });
}

const ID_RE = new RegExp("^[^\\s\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]+$");

/** Opaque identifier (Beeper chat/message/account ids). No whitespace, controls or invisible formatting characters. */
export function id(max: number): Schema<string> {
  return make({ type: "string", min: 1, max, multiline: false, format: "id" }, stringCheck({ min: 1, max, pattern: ID_RE, multiline: false }));
}

/** Opaque pagination cursor: printable ASCII only. */
export function cursor(max = 1024): Schema<string> {
  return make({ type: "string", min: 1, max, multiline: false, format: "cursor" }, stringCheck({ min: 1, max, pattern: /^[\x21-\x7e]+$/, multiline: false }));
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 date-time with an explicit timezone. */
export function isoDateTime(): Schema<string> {
  return make({ type: "string", min: 20, max: 40, multiline: false, format: "date-time" }, (input, path, ctx) => {
    if (typeof input !== "string") return ctx.add(path, `expected date-time string, got ${typeName(input)}`), INVALID;
    const m = input.length <= 40 ? ISO_RE.exec(input) : null;
    if (!m) return ctx.add(path, "must be an ISO 8601 date-time with timezone"), INVALID;
    const [mo, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60 || Number.isNaN(Date.parse(input)))
      return ctx.add(path, "is not a real date-time"), INVALID;
    return input;
  });
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard padded base64. `max` is the maximum encoded length. */
export function base64(opts: { max: number }): Schema<string> {
  return make({ type: "string", min: 0, max: opts.max, multiline: false, format: "base64" }, (input, path, ctx) => {
    if (typeof input !== "string") return ctx.add(path, `expected base64 string, got ${typeName(input)}`), INVALID;
    if (input.length > opts.max) return ctx.add(path, `must be at most ${opts.max} characters`), INVALID;
    if (!B64_RE.test(input)) return ctx.add(path, "is not valid base64"), INVALID;
    return input;
  });
}

const ASSET_RE = /^(?:mxc|localmxc):\/\/[^\s/][^\s]*$|^file:\/\/\/[^\s]+$/;

/** A Beeper media URL accepted by GET /v1/assets/serve: mxc://, localmxc:// or local file:/// without traversal. */
export function assetUrl(max = 2048): Schema<string> {
  const base = stringCheck({ min: 1, max, multiline: false });
  return make({ type: "string", min: 1, max, multiline: false, format: "asset-url" }, (input, path, ctx) => {
    const v = base(input, path, ctx);
    if (v === INVALID) return v;
    if (!ASSET_RE.test(v)) return ctx.add(path, "must be an mxc://, localmxc:// or file:/// URL"), INVALID;
    let decoded: string;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      return ctx.add(path, "has invalid percent-encoding"), INVALID;
    }
    if (/(^|[/\\])\.\.([/\\]|$)/.test(decoded) || decoded.includes("\u0000")) return ctx.add(path, "must not contain path traversal"), INVALID;
    return v;
  });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Absolute https URL (http allowed only for loopback dev). No credentials or fragment. */
export function httpUrl(max = 2048): Schema<string> {
  const base = stringCheck({ min: 1, max, multiline: false });
  return make({ type: "string", min: 1, max, multiline: false, format: "url" }, (input, path, ctx) => {
    const v = base(input, path, ctx);
    if (v === INVALID) return v;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return ctx.add(path, "must be an absolute URL"), INVALID;
    }
    const okScheme = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
    if (!okScheme || !u.hostname || u.username || u.password || v.includes("#") || !/^https?:\/\/[^/]/.test(v))
      return ctx.add(path, "must be an https URL without credentials or fragment"), INVALID;
    return v;
  });
}

export function integer(opts: { min: number; max: number }): Schema<number> {
  return make({ type: "integer", min: opts.min, max: opts.max }, (input, path, ctx) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input)) return ctx.add(path, `expected integer, got ${typeName(input)}`), INVALID;
    if (input < opts.min || input > opts.max) return ctx.add(path, `must be between ${opts.min} and ${opts.max}`), INVALID;
    return input;
  });
}

/** Finite non-negative number (sizes, durations, dimensions coming from Beeper). */
export function number(opts: { min: number; max: number }): Schema<number> {
  return make({ type: "integer", min: opts.min, max: opts.max }, (input, path, ctx) => {
    if (typeof input !== "number" || !Number.isFinite(input)) return ctx.add(path, `expected number, got ${typeName(input)}`), INVALID;
    if (input < opts.min || input > opts.max) return ctx.add(path, `must be between ${opts.min} and ${opts.max}`), INVALID;
    return input;
  });
}

export function boolean(): Schema<boolean> {
  return make({ type: "boolean" }, (input, path, ctx) => {
    if (typeof input !== "boolean") return ctx.add(path, `expected boolean, got ${typeName(input)}`), INVALID;
    return input;
  });
}

export function literal<const L extends string | number | boolean | null>(value: L): Schema<L> {
  return make({ type: "literal", value }, (input, path, ctx) => {
    if (input !== value) return ctx.add(path, `must be ${JSON.stringify(value)}`), INVALID;
    return value;
  });
}

export function enumOf<const V extends readonly string[]>(values: V): Schema<V[number]> {
  const set = new Set<string>(values);
  return make({ type: "enum", values }, (input, path, ctx) => {
    if (typeof input !== "string" || !set.has(input)) return ctx.add(path, `must be one of: ${values.join(", ")}`), INVALID;
    return input as V[number];
  });
}

export function array<T>(item: Schema<T>, opts: { min?: number; max: number }): Schema<T[]> {
  const min = opts.min ?? 0;
  return make({ type: "array", item: item.meta, min, max: opts.max }, (input, path, ctx) => {
    if (!Array.isArray(input)) return ctx.add(path, `expected array, got ${typeName(input)}`), INVALID;
    if (input.length > opts.max) return ctx.add(path, `must have at most ${opts.max} items`), INVALID;
    if (input.length < min) return ctx.add(path, `must have at least ${min} items`), INVALID;
    const out: T[] = [];
    let failed = false;
    for (let i = 0; i < input.length; i++) {
      if (!(i in input)) {
        ctx.add([...path, i], "missing item");
        failed = true;
        continue;
      }
      const v = item._check(input[i], [...path, i], ctx);
      if (v === INVALID) {
        failed = true;
        if (ctx.full) break;
      } else out.push(v);
    }
    return failed ? INVALID : out;
  });
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return { meta: inner.meta, isOptional: true, _check: (input, path, ctx) => (input === undefined ? undefined : inner._check(input, path, ctx)) };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return make({ type: "nullable", inner: inner.meta }, (input, path, ctx) => (input === null ? null : inner._check(input, path, ctx)));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Unknown keys matching this are echoed in issue paths; anything else may be user content. */
const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

type Shape = Record<string, Schema<any>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalSchema<any> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }
>;

export interface ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  readonly shape: S;
}

export function object<S extends Shape>(shape: S): ObjectSchema<S> {
  const keys = Object.keys(shape);
  const meta: Meta = {
    type: "object",
    shape: Object.fromEntries(keys.map((k) => [k, shape[k]!.meta])),
    optional: keys.filter((k) => shape[k]!.isOptional),
  };
  return {
    meta,
    isOptional: false,
    shape,
    _check(input, path, ctx) {
      if (!isPlainObject(input)) return ctx.add(path, `expected object, got ${typeName(input)}`), INVALID;
      let failed = false;
      for (const k of Object.keys(input)) {
        if (!Object.prototype.hasOwnProperty.call(shape, k)) {
          // Echo the key only when it looks like a field name; otherwise it may be content.
          ctx.add(SAFE_KEY_RE.test(k) ? [...path, k] : path, "unknown field");
          failed = true;
        }
      }
      if (failed) return INVALID;
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const has = Object.prototype.hasOwnProperty.call(input, k);
        const v = shape[k]!._check(has ? input[k] : undefined, [...path, k], ctx);
        if (v === INVALID) {
          if (!has && !shape[k]!.isOptional) {
            // _check already reported the type error; make "missing" explicit for clarity
            const last = ctx.issues[ctx.issues.length - 1];
            if (last && last.path.length === path.length + 1 && last.path[path.length] === k) last.message = "is required";
          }
          failed = true;
          if (ctx.full) break;
        } else if (v !== undefined) out[k] = v;
      }
      return failed ? INVALID : (out as InferShape<S>);
    },
  };
}

export function record<V>(key: Schema<string>, value: Schema<V>, opts: { max: number }): Schema<Record<string, V>> {
  return make({ type: "record", value: value.meta, max: opts.max }, (input, path, ctx) => {
    if (!isPlainObject(input)) return ctx.add(path, `expected object, got ${typeName(input)}`), INVALID;
    const entries = Object.keys(input);
    if (entries.length > opts.max) return ctx.add(path, `must have at most ${opts.max} entries`), INVALID;
    const out: Record<string, V> = Object.create(null);
    let failed = false;
    for (let i = 0; i < entries.length; i++) {
      const k = entries[i]!;
      // Record keys are data (chat ids, phone numbers): issues name the entry index, never the key.
      const at = [...path, `<entry ${i}>`];
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        ctx.add(at, "reserved key");
        failed = true;
        continue;
      }
      if (key._check(k, [...at, "<key>"], ctx) === INVALID) {
        failed = true;
        continue;
      }
      const v = value._check(input[k], at, ctx);
      if (v === INVALID) failed = true;
      else out[k] = v;
    }
    return failed ? INVALID : { ...out };
  });
}

/** Adds a cross-field check. `check` returns an error message or null. */
export function refine<T>(inner: Schema<T>, check: (value: T) => string | null): Schema<T> {
  return make(inner.meta, (input, path, ctx) => {
    const v = inner._check(input, path, ctx);
    if (v === INVALID) return v;
    const err = check(v);
    if (err) return ctx.add(path, err), INVALID;
    return v;
  });
}

type Variants = Record<string, Schema<any>>;

export function discriminated<K extends string, V extends Variants>(key: K, variants: V): Schema<{ [P in keyof V]: Infer<V[P]> }[keyof V]> {
  const meta: Meta = { type: "union", key, variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.meta])) };
  return make(meta, (input, path, ctx) => {
    if (!isPlainObject(input)) return ctx.add(path, `expected object, got ${typeName(input)}`), INVALID;
    const raw = input[key];
    const tag = typeof raw === "boolean" ? String(raw) : raw;
    if (typeof tag !== "string" || !Object.prototype.hasOwnProperty.call(variants, tag))
      return ctx.add([...path, key], `must be one of: ${Object.keys(variants).join(", ")}`), INVALID;
    return variants[tag]!._check(input, path, ctx) as { [P in keyof V]: Infer<V[P]> }[keyof V] | Invalid;
  });
}

/** Any JSON object (plain data only), bounded in depth and total key count. Used for envelopes whose inner shape is validated later. */
export function jsonObject(opts: { maxDepth: number; maxKeys: number }): Schema<Record<string, unknown>> {
  return make({ type: "json" }, (input, path, ctx) => {
    if (!isPlainObject(input)) return ctx.add(path, `expected object, got ${typeName(input)}`), INVALID;
    let keys = 0;
    const visit = (v: unknown, depth: number): string | null => {
      if (v === null || typeof v === "string" || typeof v === "boolean") return null;
      if (typeof v === "number") return Number.isFinite(v) ? null : "non-finite number";
      if (depth >= opts.maxDepth) return "nested too deeply";
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) return "sparse array";
          const e = visit(v[i], depth + 1);
          if (e) return e;
        }
        return null;
      }
      if (isPlainObject(v)) {
        for (const k of Object.keys(v)) {
          if (++keys > opts.maxKeys) return "too many keys";
          const e = visit(v[k], depth + 1);
          if (e) return e;
        }
        return null;
      }
      return `non-JSON value (${typeName(v)})`;
    };
    const err = visit(input, 0);
    if (err) return ctx.add(path, err), INVALID;
    return input;
  });
}

/** Any JSON value, bounded. */
export function jsonValue(opts: { maxDepth: number; maxKeys: number }): Schema<unknown> {
  const obj = jsonObject(opts);
  return make({ type: "json" }, (input, path, ctx) => obj._check({ v: input }, path, ctx) === INVALID ? INVALID : input);
}
