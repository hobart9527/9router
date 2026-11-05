/**
 * Regression test for #4283
 *
 * Gemini Antigravity rejects tool schemas that contain unknown JSON Schema
 * keywords with: "Unknown name X: Cannot find field."
 *
 * The UNSUPPORTED_SCHEMA_CONSTRAINTS list in gemini.js did not include
 * "errorMessage" (and similar non-standard annotation keywords used by some
 * MCP tool schemas), causing 400 INVALID_ARGUMENT errors on tools with error
 * documentation fields.
 *
 * Fix: add errorMessage, errorMessages, markdownDescription, and other
 * non-standard annotation keywords to the strip list.
 */

import { describe, it, expect } from "vitest";
import { cleanJSONSchemaForAntigravity, UNSUPPORTED_SCHEMA_CONSTRAINTS } from "../../open-sse/translator/formats/gemini.js";

describe("UNSUPPORTED_SCHEMA_CONSTRAINTS includes non-standard annotation keywords (#4283)", () => {
  it("includes errorMessage", () => {
    expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain("errorMessage");
  });
  it("includes errorMessages", () => {
    expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain("errorMessages");
  });
  it("includes markdownDescription", () => {
    expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain("markdownDescription");
  });
  it("includes minProperties", () => {
    expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain("minProperties");
  });
  it("includes maxProperties", () => {
    expect(UNSUPPORTED_SCHEMA_CONSTRAINTS).toContain("maxProperties");
  });
});

describe("cleanJSONSchemaForAntigravity strips errorMessage recursively (#4283)", () => {
  it("strips top-level errorMessage", () => {
    const schema = {
      type: "object",
      properties: {
        code: { type: "integer" }
      },
      errorMessage: "Invalid input"
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result).not.toHaveProperty("errorMessage");
  });

  it("strips errorMessage nested inside array items", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
            errorMessage: "Must be a non-empty string"
          }
        }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.properties.tags.items).not.toHaveProperty("errorMessage");
  });

  it("strips markdownDescription from nested property", () => {
    const schema = {
      type: "object",
      properties: {
        name: {
          type: "string",
          markdownDescription: "The **name** of the resource"
        }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.properties.name).not.toHaveProperty("markdownDescription");
  });

  it("strips minProperties / maxProperties", () => {
    const schema = {
      type: "object",
      minProperties: 1,
      maxProperties: 10,
      properties: { x: { type: "string" } }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result).not.toHaveProperty("minProperties");
    expect(result).not.toHaveProperty("maxProperties");
  });

  it("leaves other valid fields intact", () => {
    const schema = {
      type: "object",
      description: "A valid tool",
      properties: {
        n: { type: "number", description: "A number" }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.description).toBe("A valid tool");
    expect(result.properties.n.description).toBe("A number");
  });

  it("preserves property names matching unsupported keyword constraints (title, format, default)", () => {
    const schema = {
      type: "object",
      title: "RootSchemaTitle",
      properties: {
        title: {
          type: "string",
          title: "ParameterMetadataTitle",
          minLength: 1,
          maxLength: 60,
          description: "agent title"
        },
        format: {
          type: "string",
          description: "output format",
          default: "json"
        },
        provider: { type: "string" }
      },
      required: ["title", "format", "provider"]
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    // Root schema metadata title should be stripped
    expect(result).not.toHaveProperty("title");
    // Parameter properties should be preserved
    expect(result.properties).toHaveProperty("title");
    expect(result.properties).toHaveProperty("format");
    expect(result.properties).toHaveProperty("provider");
    expect(result.properties.title.type).toBe("string");
    expect(result.properties.title.description).toBe("agent title");
    // Metadata/constraints inside parameter schema should be stripped
    expect(result.properties.title).not.toHaveProperty("title");
    expect(result.properties.title).not.toHaveProperty("minLength");
    expect(result.properties.title).not.toHaveProperty("maxLength");
    expect(result.properties.format).not.toHaveProperty("default");
    // Required array should retain valid property names
    expect(result.required).toEqual(["title", "format", "provider"]);
  });

  it("preserves nested properties named title inside sub-objects", () => {
    const schema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          title: "SettingsSchemaTitle",
          properties: {
            title: {
              type: "string",
              description: "nested title"
            }
          },
          required: ["title"]
        }
      }
    };
    const result = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(result.properties.settings).not.toHaveProperty("title");
    expect(result.properties.settings.properties).toHaveProperty("title");
    expect(result.properties.settings.properties.title.description).toBe("nested title");
    expect(result.properties.settings.required).toEqual(["title"]);
  });
});