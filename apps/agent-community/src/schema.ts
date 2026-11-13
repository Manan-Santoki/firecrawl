import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats ships CJS; under NodeNext its default export is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv) => Ajv;

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);

const cache = new WeakMap<object, ValidateFunction>();

export function compileSchema(schema: unknown): ValidateFunction | null {
  if (!schema || typeof schema !== "object") return null;
  const cached = cache.get(schema);
  if (cached) return cached;
  const fn = ajv.compile(schema as object);
  cache.set(schema, fn);
  return fn;
}

export function validateData(schema: unknown, data: unknown): { ok: boolean; errors: string[] } {
  const fn = compileSchema(schema);
  if (!fn) return { ok: true, errors: [] };
  const ok = fn(data) as boolean;
  return {
    ok,
    errors: ok ? [] : (fn.errors ?? []).slice(0, 20).map(e => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
  };
}

/** Pull a JSON value out of model text that may carry fences or prose around it. */
export function parseJsonLoose(text: string | null | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: false };
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstObj = trimmed.indexOf("{");
  const lastObj = trimmed.lastIndexOf("}");
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(trimmed.slice(firstObj, lastObj + 1));
  const firstArr = trimmed.indexOf("[");
  const lastArr = trimmed.lastIndexOf("]");
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(trimmed.slice(firstArr, lastArr + 1));
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false };
}
