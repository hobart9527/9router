// Codex-specific tool JSON Schema compatibility.
//
// `https://chatgpt.com/backend-api/codex/responses` validates every function
// tool's `parameters` with a regex engine that does not implement Unicode
// property escapes. A `pattern` such as
//
//   "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$"
//
// is a perfectly valid ECMAScript `u`-mode regex, but Codex answers
//
//   400 Invalid schema for function 'Artifact': '^\p{Cc}...' is not a 'regex'
//   param: tools[0].parameters
//
// The request is deterministically malformed for this provider, so every
// account fails identically and the combo pays a full failover before landing
// somewhere that accepts it (#3922).
//
// Scope guardrail (#3667): this is NOT a global schema sanitizer. Providers
// that do support `\p{...}` keep the constraint untouched — the strip runs only
// on the Codex dispatch path, and only on `pattern` strings that actually
// contain a property escape. Everything else in the schema (including valid
// patterns) passes through byte-identical.

// `\p{...}` / `\P{...}` with an odd number of preceding backslashes — an even
// count means the backslash itself is escaped, so `\\p{Cc}` is a literal "p".
const UNICODE_PROPERTY_ESCAPE = /(^|[^\\])(\\\\)*\\[pP]\{/;

export function hasUnicodePropertyEscape(pattern) {
  return typeof pattern === "string" && UNICODE_PROPERTY_ESCAPE.test(pattern);
}

// Copy-on-write walk: returns the original reference when nothing changed, so
// untouched schemas keep object identity and callers can cheaply detect a no-op.
// `properties` is special-cased because its keys are arbitrary property *names*
// (which may themselves be "pattern" or "properties") and must never be read as
// schema keywords; every other key recurses as an ordinary schema node.
function stripNode(node, stats) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const cleaned = stripNode(item, stats);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && hasUnicodePropertyEscape(value)) {
      stats.removed++;
      changed = true;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      let propsChanged = false;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const cleaned = stripNode(propSchema, stats);
        if (cleaned !== propSchema) propsChanged = true;
        props[propName] = cleaned;
      }
      if (propsChanged) changed = true;
      next[key] = propsChanged ? props : value;
      continue;
    }
    const cleaned = stripNode(value, stats);
    if (cleaned !== value) changed = true;
    next[key] = cleaned;
  }
  return changed ? next : node;
}

// Remove only the `pattern` constraints Codex's validator rejects.
// Returns the same reference when the schema is already compatible.
export function stripCodexUnsupportedPatterns(schema, stats = { removed: 0 }) {
  return stripNode(schema, stats);
}

// Keywords Codex refuses on a parameters ROOT, alongside a missing `type: "object"`:
//
//   Invalid schema for function '_create_site': schema must have type 'object'
//   and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level.
//   param: tools[17].tools[2].parameters
//
// The constraint is on the ROOT only — nested property schemas may use composite
// keywords freely — so this normalizes the root and leaves every descendant byte-
// identical. Same scope guardrail as the pattern strip: Codex dispatch path only.
const ROOT_REJECTED_KEYWORDS = ["enum", "const", "not"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Prefer the branch that can actually describe the tool's argument object.
function pickCompositeBranch(branches) {
  const candidates = branches.filter(isPlainObject).filter((branch) => branch.type !== "null");
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = candidate.type === "object" || candidate.properties
      ? 3
      : candidate.type === "array" || candidate.items ? 2 : 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Normalize a function tool's `parameters` root into the shape Codex accepts.
 * Flattens root-level `oneOf`/`anyOf` (best branch) and `allOf` (merge), drops
 * root-level `enum`/`const`/`not`, and guarantees `type: "object"`. A schema
 * that was already acceptable is returned by identity, so callers can pass a
 * shared schema across providers without it being rewritten for Codex.
 */
export function normalizeCodexToolParameters(schema) {
  if (!isPlainObject(schema)) return { type: "object", properties: {} };
  if (schema.type === "object" && !hasRootRejectedKeyword(schema)) return schema;

  const merged = { ...schema };
  for (const key of ["oneOf", "anyOf"]) {
    if (!Array.isArray(merged[key])) continue;
    const branch = pickCompositeBranch(merged[key]);
    delete merged[key];
    if (branch) {
      for (const [branchKey, value] of Object.entries(branch)) {
        if (merged[branchKey] === undefined) merged[branchKey] = value;
      }
    }
  }
  if (Array.isArray(merged.allOf)) {
    const parts = merged.allOf.filter(isPlainObject);
    delete merged.allOf;
    for (const part of parts) {
      for (const [key, value] of Object.entries(part)) {
        if (key === "properties" && isPlainObject(value)) {
          merged.properties = { ...(isPlainObject(merged.properties) ? merged.properties : {}), ...value };
        } else if (key === "required" && Array.isArray(value)) {
          merged.required = [...new Set([...(Array.isArray(merged.required) ? merged.required : []), ...value])];
        } else if (merged[key] === undefined) {
          merged[key] = value;
        }
      }
    }
  }
  for (const key of ROOT_REJECTED_KEYWORDS) delete merged[key];
  merged.type = "object";
  return merged;
}

function hasRootRejectedKeyword(schema) {
  for (const key of ["oneOf", "anyOf", "allOf", ...ROOT_REJECTED_KEYWORDS]) {
    if (Array.isArray(schema[key]) ? schema[key].length > 0 : key in schema) return true;
  }
  return false;
}
