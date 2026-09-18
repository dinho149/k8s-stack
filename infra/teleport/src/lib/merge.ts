/** Deep-merge plain objects (arrays and primitives are replaced, not concatenated). */
export type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export function deepMerge<T>(base: T, ...overrides: Array<DeepPartial<T> | undefined>): T {
  let out: any = Array.isArray(base) ? [...(base as any)] : isObject(base) ? { ...(base as any) } : base;
  for (const o of overrides) {
    if (o === undefined) continue;
    if (!isObject(o) || !isObject(out)) {
      out = o;
      continue;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = isObject(v) && isObject(out[k]) && !Array.isArray(v) ? deepMerge(out[k], v as any) : v;
    }
  }
  return out as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
