/**
 * Compact tool definitions to cut the token cost of the `tools` array.
 *
 * Two opt-in passes, applied in order:
 *  1. Annotation-key stripping — remove JSON Schema annotation keywords
 *     ($schema, $id, title, examples, …) that constrain nothing about the
 *     accepted input, and collapse whitespace in `description` strings.
 *  2. Description truncation — keep the first sentence of every tool and
 *     parameter description so the model can still pick the right tool,
 *     dropping the rest.
 *
 * Both tool wire shapes are handled: Claude (`input_schema`) and OpenAI
 * (`function.parameters`). The walker visits schema-bearing keywords,
 * preserving business field names and literal JSON values.
 *
 * Fail-open by contract (mirrors rtk/ and toolDeduper): any error returns the
 * original tools untouched, never throws.
 */

// JSON Schema annotation keywords — removing any of them does not change the
// set of valid inputs. Kept in sync with headroom's tool_schema_compaction.
const SCHEMA_ANNOTATION_KEYS = new Set([
  "$id",
  "$schema",
  "$comment",
  "deprecated",
  "examples",
  "example",
  "markdownDescription",
  "readOnly",
  "writeOnly",
  "title",
]);

// Default cap for a single description, in characters. 0 disables truncation.
// The cap keeps the first complete sentence; a description with no sentence
// break is kept whole up to this many characters.
const DEFAULT_DESC_MAX_CHARS = 0;

// UTF-8 byte size of a JSON value; 0 when it cannot be serialized. Uses
// TextEncoder (not Buffer) to stay portable across the open-sse runtimes.
function utf8Bytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

// Hard-cut `text` to at most `maxChars`, preferring the last word boundary so a
// truncated description does not end mid-word.
function cutAtWordBoundary(text, maxChars) {
  const head = text.slice(0, maxChars);
  const boundary = head.lastIndexOf(" ");
  return (boundary > maxChars * 0.5 ? head.slice(0, boundary) : head).trim();
}

function truncateToFirstSentence(text, maxChars) {
  if (!(maxChars > 0) || text.length <= maxChars) return text;
  // Sentence boundary: . ! ? (or a CJK full stop) followed by whitespace/end.
  const match = text.match(/^[\s\S]*?[.!?。！？](?=\s|$)/);
  // Keep the first sentence only when it fits the cap; a long opening sentence
  // must still be clamped or the caller's limit would be silently exceeded.
  if (match && match[0].length >= 20 && match[0].length <= maxChars) {
    return match[0].trim();
  }
  // No usable sentence break (or the sentence overruns the cap) — hard-cut.
  return cutAtWordBoundary(text, maxChars);
}

function compactDescription(desc, maxChars) {
  if (typeof desc !== "string" || desc.length === 0) return desc;
  const collapsed = collapseWhitespace(desc);
  return truncateToFirstSentence(collapsed, maxChars);
}

// Only schema-bearing keywords recurse. Name maps and literal JSON values are
// not schema nodes: stripping their keys would change valid tool inputs.
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_KEYS = new Set([
  "items", "prefixItems", "additionalItems", "contains", "additionalProperties",
  "unevaluatedProperties", "unevaluatedItems", "propertyNames", "allOf", "anyOf",
  "oneOf", "not", "if", "then", "else", "contentSchema",
]);

function walk(value, maxChars, stats, context = "tool") {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, maxChars, stats, context));
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (context === "schema" && SCHEMA_ANNOTATION_KEYS.has(key)) {
      stats.keysDropped += 1;
      return [];
    }
    if (key === "description" && typeof child === "string") {
      const compacted = compactDescription(child, maxChars);
      if (compacted !== child) stats.descriptionsChanged += 1;
      return [[key, compacted]];
    }
    if (context === "schema" && (SCHEMA_MAP_KEYS.has(key) || key === "dependencies")) {
      const mapped = child && typeof child === "object" && !Array.isArray(child)
        ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [
          name, Array.isArray(schema) ? schema : walk(schema, maxChars, stats, "schema"),
        ]))
        : child;
      return [[key, mapped]];
    }
    if ((context === "schema" && SCHEMA_KEYS.has(key)) ||
        (context === "tool" && (key === "parameters" || key === "input_schema"))) {
      return [[key, walk(child, maxChars, stats, "schema")]];
    }
    if (context === "tool" && key === "function") {
      return [[key, walk(child, maxChars, stats, "tool")]];
    }
    return [[key, child]];
  }));
}

/**
 * Compact a `tools` array in place (each entry replaced by its compacted copy).
 * @param {Array} tools - Claude or OpenAI tool definition array.
 * @param {object} [options]
 * @param {number} [options.descMaxChars] - per-description char cap (0 = off).
 * @returns {{tools: Array, changed: boolean, stats: object}}
 */
function compactToolSchema(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, changed: false, stats: emptyStats() };
  }
  const maxChars = Number.isFinite(options.descMaxChars)
    ? options.descMaxChars
    : DEFAULT_DESC_MAX_CHARS;
  const stats = emptyStats();
  try {
    const out = tools.map((tool) => walk(tool, maxChars, stats));
    const changed = stats.keysDropped > 0 || stats.descriptionsChanged > 0;
    if (!changed) return { tools, changed: false, stats };
    return { tools: out, changed: true, stats };
  } catch {
    // Fail-open: leave the caller's tools untouched on any unexpected shape.
    return { tools, changed: false, stats: emptyStats() };
  }
}

function emptyStats() {
  return { keysDropped: 0, descriptionsChanged: 0 };
}

// Convenience: format a log message from stats. Returns the bare message so the
// logger supplies the "[TOOLSCHEMA]" tag exactly once.
function formatToolSchemaLog(stats, bytesBefore, bytesAfter) {
  if (!stats || (stats.keysDropped === 0 && stats.descriptionsChanged === 0)) return null;
  const saved = bytesBefore - bytesAfter;
  const pct = bytesBefore > 0 ? ((saved / bytesBefore) * 100).toFixed(1) : "0";
  return `saved ${saved}B / ${bytesBefore}B (${pct}%) keys=${stats.keysDropped} descs=${stats.descriptionsChanged}`;
}

export {
  compactToolSchema,
  formatToolSchemaLog,
  utf8Bytes,
  SCHEMA_ANNOTATION_KEYS,
  DEFAULT_DESC_MAX_CHARS,
};
