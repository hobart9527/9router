import { describe, it, expect } from "vitest";
import {
  compactToolSchema,
  formatToolSchemaLog,
  SCHEMA_ANNOTATION_KEYS,
  DEFAULT_DESC_MAX_CHARS,
} from "../../open-sse/utils/toolSchemaCompactor.js";

// A tool shaped like a real Claude Code tool definition.
function claudeTool(over = {}) {
  return {
    name: "Read",
    description: "Reads a file from disk. " + "Use this before editing. ".repeat(20),
    input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "read-tool",
      title: "Read",
      type: "object",
      properties: {
        file_path: {
          type: "string",
          title: "File path",
          description: "The path to read. " + "Must be absolute. ".repeat(20),
        },
        offset: { type: "number", description: "Line to start at." },
      },
      required: ["file_path"],
    },
    ...over,
  };
}

function openaiTool() {
  return {
    type: "function",
    function: {
      name: "read_file",
      description: "Reads a file from disk. And explains more. " + "Extra prose. ".repeat(20),
      parameters: {
        $comment: "internal",
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path. More detail follows here. " + "Even more. ".repeat(20) },
        },
      },
    },
  };
}

describe("compactToolSchema — annotation key stripping", () => {
  it("drops JSON Schema annotation keys wherever they appear", () => {
    const { tools, changed, stats } = compactToolSchema([claudeTool()], { descMaxChars: 0 });
    expect(changed).toBe(true);
    const schema = tools[0].input_schema;
    for (const key of ["$schema", "$id", "title"]) {
      expect(schema).not.toHaveProperty(key);
    }
    expect(schema.properties.file_path).not.toHaveProperty("title");
    expect(stats.keysDropped).toBeGreaterThanOrEqual(4);
  });

  it("preserves every validation keyword and the required array", () => {
    const { tools } = compactToolSchema([claudeTool()], { descMaxChars: 0 });
    const schema = tools[0].input_schema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["file_path"]);
    expect(schema.properties.offset.type).toBe("number");
    expect(schema.properties.file_path.type).toBe("string");
  });

  it("treats every key in SCHEMA_ANNOTATION_KEYS as strippable", () => {
    const nested = {};
    for (const key of SCHEMA_ANNOTATION_KEYS) nested[key] = "x";
    nested.type = "object";
    const tool = { name: "t", input_schema: { properties: { p: nested } } };
    const { tools } = compactToolSchema([tool], { descMaxChars: 0 });
    const p = tools[0].input_schema.properties.p;
    for (const key of SCHEMA_ANNOTATION_KEYS) expect(p).not.toHaveProperty(key);
    expect(p.type).toBe("object");
  });
});

describe("compactToolSchema — description truncation", () => {
  it("keeps the first sentence and collapses whitespace", () => {
    const { tools, stats } = compactToolSchema([claudeTool()], { descMaxChars: 200 });
    const desc = tools[0].description;
    expect(desc).toBe("Reads a file from disk.");
    expect(stats.descriptionsChanged).toBeGreaterThanOrEqual(1);
  });

  it("truncates nested parameter descriptions too", () => {
    const { tools } = compactToolSchema([claudeTool()], { descMaxChars: 200 });
    const nested = tools[0].input_schema.properties.file_path.description;
    expect(nested.length).toBeLessThanOrEqual(200);
    expect(nested.startsWith("The path to read.")).toBe(true);
  });

  it("keeps descriptions when the cap is 0 (strip-only mode)", () => {
    const { tools } = compactToolSchema([claudeTool()], { descMaxChars: 0 });
    expect(tools[0].description).toContain("Use this before editing.");
  });

  it("leaves short descriptions untouched", () => {
    const { tools } = compactToolSchema([claudeTool()], { descMaxChars: 200 });
    expect(tools[0].input_schema.properties.offset.description).toBe("Line to start at.");
  });

  it("clamps even when the first sentence alone exceeds the cap", () => {
    const long = "IMPORTANT: this first sentence is deliberately far longer than the cap so the sentence-boundary rule cannot apply here. Second.";
    const tool = { name: "x", description: long, input_schema: { type: "object", properties: {} } };
    const { tools } = compactToolSchema([tool], { descMaxChars: 60 });
    expect(tools[0].description.length).toBeLessThanOrEqual(60);
  });

  it("never returns a description longer than the configured cap", () => {
    const cases = [
      "Short first. " + "pad ".repeat(200),
      "no terminator at all ".repeat(30),
      "。中文句一。中文句二。".repeat(20),
    ];
    for (const desc of cases) {
      for (const cap of [50, 100, 200]) {
        const tool = { name: "x", description: desc, input_schema: { type: "object", properties: {} } };
        const { tools } = compactToolSchema([tool], { descMaxChars: cap });
        expect(tools[0].description.length).toBeLessThanOrEqual(cap);
      }
    }
  });
});

describe("compactToolSchema — shape handling", () => {
  it("handles OpenAI function.parameters shape", () => {
    const { tools, changed } = compactToolSchema([openaiTool()], { descMaxChars: 200 });
    expect(changed).toBe(true);
    expect(tools[0].function.parameters).not.toHaveProperty("$comment");
    expect(tools[0].function.parameters.properties.path.description.length).toBeLessThanOrEqual(200);
  });

  it("does not mutate the caller's tools array or objects", () => {
    const original = [claudeTool()];
    const snapshot = JSON.stringify(original);
    compactToolSchema(original, { descMaxChars: 200 });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("is idempotent", () => {
    const once = compactToolSchema([claudeTool()], { descMaxChars: 200 }).tools;
    const twice = compactToolSchema(once, { descMaxChars: 200 });
    expect(twice.changed).toBe(false);
    expect(twice.tools).toEqual(once);
  });

  it("returns changed:false and the original array for empty or non-array input", () => {
    expect(compactToolSchema([], { descMaxChars: 200 })).toMatchObject({ changed: false });
    expect(compactToolSchema(null).changed).toBe(false);
    expect(compactToolSchema(undefined).changed).toBe(false);
  });

  it("fails open on a tool whose properties throw, returning the original", () => {
    const bad = { name: "t", input_schema: {} };
    Object.defineProperty(bad.input_schema, "properties", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const { tools, changed } = compactToolSchema([bad], { descMaxChars: 200 });
    expect(changed).toBe(false);
    expect(tools[0]).toBe(bad);
  });
});

describe("formatToolSchemaLog", () => {
  it("reports saved bytes and percentages", () => {
    const line = formatToolSchemaLog({ keysDropped: 3, descriptionsChanged: 2 }, 1000, 600);
    expect(line).toContain("saved 400B / 1000B (40.0%)");
    expect(line).toContain("keys=3");
    expect(line).toContain("descs=2");
  });

  it("returns null when nothing changed", () => {
    expect(formatToolSchemaLog({ keysDropped: 0, descriptionsChanged: 0 }, 100, 100)).toBeNull();
    expect(formatToolSchemaLog(null, 100, 100)).toBeNull();
  });
});

describe("defaults", () => {
  it("disables truncation by default (strip-only)", () => {
    expect(DEFAULT_DESC_MAX_CHARS).toBe(0);
  });
});
