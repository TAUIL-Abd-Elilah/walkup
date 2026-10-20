/**
 * Zod -> JSON schema for `output_config.format`, keeping `enum`.
 *
 * Why not zodOutputFormat(): in SDK 0.133 its transformJSONSchema keeps only
 * `format` on string nodes and moves every other keyword, `enum` included,
 * into the description. The per-run id enums would then be a hint, not a
 * decoding constraint. The API supports `enum`, `const`, `anyOf`, `$ref`, so
 * this converter keeps them and drops only what structured outputs rejects
 * (numeric and string-length constraints), noting dropped keywords in the
 * description as the SDK does. The zod schema still validates the parsed
 * answer client-side.
 */
import { z } from "zod";

type Json = Record<string, unknown>;

const KEEP = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "items",
  "description",
  "title",
  "format",
  "minItems",
  "$ref",
  "$defs",
]);

const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalize(node: unknown): Json {
  if (!isObj(node)) return {};
  // ["string", "null"] -> anyOf, which every structured-output schema accepts.
  if (Array.isArray(node["type"])) {
    const { type, description, ...rest } = node;
    const variants = (type as unknown[]).map((t) => normalize({ ...rest, type: t }));
    return description !== undefined ? { anyOf: variants, description } : { anyOf: variants };
  }

  const out: Json = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!KEEP.has(key)) {
      dropped.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    switch (key) {
      case "properties":
        out[key] = Object.fromEntries(Object.entries(isObj(value) ? value : {}).map(([k, v]) => [k, normalize(v)]));
        break;
      case "$defs":
        out[key] = Object.fromEntries(Object.entries(isObj(value) ? value : {}).map(([k, v]) => [k, normalize(v)]));
        break;
      case "items":
        out[key] = normalize(value);
        break;
      case "anyOf":
      case "allOf":
        out[key] = Array.isArray(value) ? value.map(normalize) : [];
        break;
      case "minItems":
        if (value === 0 || value === 1) out[key] = value;
        else dropped.push(`minItems: ${JSON.stringify(value)}`);
        break;
      case "format":
        if (typeof value === "string" && FORMATS.has(value)) out[key] = value;
        else dropped.push(`format: ${JSON.stringify(value)}`);
        break;
      default:
        out[key] = value;
    }
  }
  if (out["type"] === "object") {
    out["additionalProperties"] = false;
    if (!out["properties"]) out["properties"] = {};
  }
  if (dropped.length > 0) {
    const d = typeof out["description"] === "string" ? `${out["description"]}\n\n` : "";
    out["description"] = `${d}{${dropped.join(", ")}}`;
  }
  return out;
}

/** JSON schema for a zod schema, ready for `output_config.format.schema` (enums kept). */
export function strictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { reused: "inline", unrepresentable: "throw" }) as Json;
  delete raw["$schema"];
  return normalize(raw);
}

/** `{ type: "json_schema", schema }` for `output_config.format`. */
export function jsonOutputFormat(schema: z.ZodType): { type: "json_schema"; schema: Json } {
  return { type: "json_schema", schema: strictJsonSchema(schema) };
}
