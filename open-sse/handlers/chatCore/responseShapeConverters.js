// Leaf module (no internal imports) so both nonStreamingHandler and
// sseToJsonHandler can share these response-shape converters without a cycle.
import { FORMATS } from "../../translator/formats.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";

export function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

/** chat.completion → Claude Message */
export function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

/** chat.completion → OpenAI Responses `response` object */
export function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  const status = choice.finish_reason === "tool_calls" ? "completed" : (choice.finish_reason === "stop" ? "completed" : (choice.finish_reason || "completed"));

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status,
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

/** Responses `output[]` → OpenAI tool_calls (handles function_call and custom_tool_call) */
export function extractToolCallsFromResponsesOutput(output) {
  return (output || [])
    .filter((item) => item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL)
    .map((item, idx) => {
      const isCustom = item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
      return {
        id: item.call_id || item.id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: isCustom
            ? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
            : (typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})),
        },
      };
    });
}

/** Responses `response` object → chat.completion */
export function responsesJsonToChatCompletion(responseBody, fallbackModel = "unknown") {
  if (!Array.isArray(responseBody?.output)) return responseBody;

  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const item of responseBody.output) {
    if (item?.type === RESPONSES_ITEM.MESSAGE) {
      const text = Array.isArray(item.content)
        ? item.content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("")
        : (typeof item.content === "string" ? item.content : "");
      if (text) textParts.push(text);
    } else if (item?.type === RESPONSES_ITEM.REASONING) {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((s) => typeof s?.text === "string").map((s) => s.text).join("")
        : "";
      if (summary) reasoningParts.push(summary);
    } else if (item?.type === RESPONSES_ITEM.FUNCTION_CALL) {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments || {}),
        },
      });
    } else if (item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      // Custom tools carry a freeform `input` string, not a JSON `arguments`
      // object. Wrap it in {input} so the reverse (extractCustomToolInput) and
      // Claude's tool_use.input (which must be an object) both round-trip.
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: JSON.stringify({ input: typeof item.input === "string" ? item.input : "" }),
        },
      });
    }
  }

  const message = { role: ROLE.ASSISTANT };
  if (textParts.length > 0) message.content = textParts.join("");
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (!message.content && !message.tool_calls) message.content = "";

  const done = responseBody.status === "completed" || responseBody.status === "done";
  const finishReason = toolCalls.length > 0 ? "tool_calls" : (done ? "stop" : (responseBody.status || "stop"));

  const usage = responseBody.usage || {};
  const result = {
    id: `chatcmpl-${responseBody.id || Date.now()}`.replace(/^chatcmpl-resp_/, "chatcmpl-"),
    object: "chat.completion",
    created: responseBody.created_at || Math.floor(Date.now() / 1000),
    model: responseBody.model || fallbackModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage && Object.keys(usage).length > 0) {
    result.usage = {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
    };
  }
  return result;
}
