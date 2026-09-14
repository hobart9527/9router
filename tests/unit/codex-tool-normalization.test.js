import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function normalizeTools(tools) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };

  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-tools",
    providerSpecificData: {},
  });

  return body.tools;
}

describe("CodexExecutor tool normalization", () => {
  it("preserves Responses text.format for structured outputs", () => {
    const executor = new CodexExecutor();
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    };
    const body = {
      model: "gpt-5.4-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test for session title" }] }],
      stream: true,
      metadata: { unsupported: true },
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    };

    executor.transformRequest("gpt-5.4-mini", body, true, {
      connectionId: "test-codex-structured-output",
      providerSpecificData: {},
    });

    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "codex_output_schema",
        strict: true,
        schema,
      },
    });
    expect(body.metadata).toBeUndefined();
  });

  it("preserves Responses-native tool_search tools", () => {
    const tools = normalizeTools([
      {
        type: "tool_search",
        execution: "sync",
        description: "Discover deferred tools",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "namespace",
        name: "codex_app",
        description: "app tools",
        tools: [
          {
            type: "function",
            name: "automation_update",
            description: "automation",
            parameters: { type: "object", properties: {} },
            defer_loading: true,
          },
        ],
      },
      {
        type: "function",
        name: "plain_fn",
        description: "plain",
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(tools.map((tool) => `${tool.type}:${tool.name || ""}`)).toEqual([
      "tool_search:",
      "namespace:codex_app",
      "function:plain_fn",
    ]);
  });

  it("preserves hosted Responses tools", () => {
    const tools = normalizeTools([
      { type: "web_search", search_context_size: "medium" },
      { type: "image_generation", size: "1024x1024" },
      { type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" },
      { type: "local_shell" },
      { type: "code_interpreter", container: { type: "auto" } },
      { type: "computer", display_width: 1024, display_height: 768, environment: "browser" },
    ]);

    expect(tools.map((tool) => tool.type)).toEqual([
      "web_search",
      "image_generation",
      "mcp",
      "local_shell",
      "code_interpreter",
      "computer",
    ]);
  });

  it("strips only Unicode-property patterns rejected by Codex", () => {
    const unicodePattern = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,200}$";
    const validPattern = "^[a-z][a-z0-9_-]{0,31}$";
    const sourceParameters = {
      type: "object",
      properties: {
        artifact: {
          type: "object",
          properties: {
            name: { type: "string", pattern: unicodePattern },
            slug: { type: "string", pattern: validPattern },
          },
        },
        // A property named "pattern" is data, not the schema keyword.
        pattern: { type: "string", pattern: validPattern },
        // Nested composite, not a root-level one: Codex rejects a root
        // allOf/oneOf outright, so the walk must be exercised where a composite
        // keyword is actually legal (#3923).
        variant: { oneOf: [{ type: "object", properties: { title: { type: "string", pattern: unicodePattern } } }] },
      },
    };
    const tools = normalizeTools([{
      type: "function",
      name: "Artifact",
      parameters: sourceParameters,
    }]);

    expect(tools[0].parameters.properties.artifact.properties.name.pattern).toBeUndefined();
    expect(tools[0].parameters.properties.artifact.properties.slug.pattern).toBe(validPattern);
    expect(tools[0].parameters.properties.pattern.pattern).toBe(validPattern);
    expect(tools[0].parameters.properties.variant.oneOf[0].properties.title.pattern).toBeUndefined();
    // Copy-on-write: the caller's schema remains available for another provider.
    expect(sourceParameters.properties.artifact.properties.name.pattern).toBe(unicodePattern);
  });

  it("keeps escaped literal property text and schema identity when no strip is needed", () => {
    const parameters = {
      type: "object",
      properties: {
        literal: { type: "string", pattern: "^\\\\p{Cc}$" },
        simple: { type: "string", pattern: "^[A-Z]+$" },
      },
    };
    const tools = normalizeTools([{ type: "function", name: "probe", parameters }]);

    expect(tools[0].parameters).toBe(parameters);
    expect(tools[0].parameters.properties.literal.pattern).toBe("^\\\\p{Cc}$");
  });

  it("sanitizes nested namespace function schemas", () => {
    const tools = normalizeTools([{
      type: "namespace",
      name: "agent",
      tools: [{
        type: "function",
        name: "Artifact",
        parameters: {
          type: "object",
          properties: { name: { type: "string", pattern: "^\\p{Cc}+$" } },
        },
      }],
    }]);

    expect(tools[0].tools[0].parameters.properties.name.pattern).toBeUndefined();
  });

  it("preserves custom freeform tools with format payloads", () => {
    const tools = normalizeTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]);
  });

  // #3923 — Codex rejects a parameters ROOT carrying oneOf/anyOf/allOf/enum/const/not,
  // or missing type:"object":
  //   "schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/
  //    'const'/'not' at the top level", param tools[17].tools[2].parameters.
  // The offending tool came in nested under a namespace tool, so both branches
  // must normalize.
  it("flattens a root oneOf into the object branch Codex accepts", () => {
    const tools = normalizeTools([{
      type: "function",
      name: "_create_site",
      parameters: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        ],
      },
    }]);

    expect(tools[0].parameters.type).toBe("object");
    expect(tools[0].parameters.oneOf).toBeUndefined();
    expect(tools[0].parameters.properties.name).toEqual({ type: "string" });
    expect(tools[0].parameters.required).toEqual(["name"]);
  });

  it("normalizes the root of a namespace-nested tool", () => {
    const tools = normalizeTools([{
      type: "namespace",
      name: "mcp_sites",
      tools: [{
        type: "function",
        name: "_create_site",
        parameters: {
          allOf: [
            { type: "object", properties: { name: { type: "string" } } },
            { properties: { slug: { type: "string" } }, required: ["slug"] },
          ],
        },
      }],
    }]);

    const params = tools[0].tools[0].parameters;
    expect(params.type).toBe("object");
    expect(params.allOf).toBeUndefined();
    expect(params.properties).toEqual({ name: { type: "string" }, slug: { type: "string" } });
    expect(params.required).toEqual(["slug"]);
  });

  it("drops root enum/const/not but leaves nested composites intact", () => {
    const nestedUnion = { type: "object", properties: { a: { type: "string" } } };
    const tools = normalizeTools([{
      type: "function",
      name: "pick",
      parameters: {
        type: "object",
        not: { required: ["forbidden"] },
        properties: {
          mode: { enum: ["fast", "slow"], default: "fast" },
          payload: { oneOf: [nestedUnion, { type: "string" }] },
        },
      },
    }]);

    expect(tools[0].parameters.not).toBeUndefined();
    // Nested property schemas keep their own composite keywords — Codex's
    // restriction is root-only, and rewriting them would lose type information.
    expect(tools[0].parameters.properties.mode.enum).toEqual(["fast", "slow"]);
    expect(tools[0].parameters.properties.payload.oneOf).toHaveLength(2);
  });

  it("keeps an already-acceptable root schema by identity", () => {
    const parameters = { type: "object", properties: { a: { type: "string" } } };
    const tools = normalizeTools([{ type: "function", name: "noop", parameters }]);

    expect(tools[0].parameters).toBe(parameters);
  });
});
