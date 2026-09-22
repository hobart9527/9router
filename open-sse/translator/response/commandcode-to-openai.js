/**
 * CommandCode → OpenAI response translator
 *
 * CommandCode upstream emits NDJSON-style AI SDK v5 stream events:
 *   {"type":"start"} {"type":"start-step", ...}
 *   {"type":"reasoning-start","id":"..."} {"type":"reasoning-delta","text":"..."}
 *   {"type":"text-start","id":"..."}     {"type":"text-delta","text":"..."}
 *   {"type":"tool-input-start","id","toolName"}
 *   {"type":"tool-input-delta","id","delta"}
 *   {"type":"tool-input-end","id"}
 *   {"type":"tool-call","toolCallId","toolName","input"}
 *   {"type":"finish-step","finishReason","usage": {...}, ...}
 *   {"type":"finish",...}
 *
 * Each upstream "event" arrives as one JSON object per line — we receive it as a string chunk
 * already split per line by the upstream SSE/JSON-line reader in 9router.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, OPENAI_FINISH } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";

function ensureState(state, model) {
  if (!state.responseId) {
    state.responseId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.model = state.model || model || "commandcode";
    state.chunkIndex = 0;
    state.toolIndex = 0;
    state.toolIndexById = new Map();
    state.openTools = new Set();
    state.openText = false;
    state.finishReason = null;
    state.usage = null;
    // Argument bytes emitted per tool id. The consolidated `tool-call` event is the
    // authoritative full input, so we must know whether it is a duplicate of what we
    // already streamed or the only copy we will ever get.
    state.toolArgBytes = new Map();
    // Argument text whose tool id never saw a tool-input-start. Kept so the consolidated
    // tool-call can fall back to it when it carries no `input` of its own.
    state.pendingArgText = new Map();
  }
}

function makeChunk(state, delta, finishReason = null) {
  return buildChunk(
    { id: state.responseId, created: state.created, model: state.model },
    delta,
    finishReason
  );
}

const mapFinishReason = (reason) => toOpenAIFinish(reason, "commandcode");

export function commandCodeToOpenAIResponse(chunk, state) {
  if (!chunk) return null;

  // Already-OpenAI chunk: pass through
  if (chunk && typeof chunk === "object" && chunk.object === "chat.completion.chunk") {
    return chunk;
  }

  // Parse string lines coming out of upstream
  let event = chunk;
  if (typeof chunk === "string") {
    const line = chunk.trim();
    if (!line) return null;
    // Tolerate raw "data: {...}" framing if the upstream wrapper inserts it
    const json = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!json || json === "[DONE]") return null;
    try {
      event = JSON.parse(json);
    } catch {
      return null;
    }
  }

  if (!event || typeof event !== "object" || !event.type) return null;

  ensureState(state, event.model);
  const out = [];

  switch (event.type) {
    case "text-delta": {
      const text = event.text || event.delta || "";
      if (!text) break;
      const delta = state.chunkIndex === 0 ? { role: ROLE.ASSISTANT, content: text } : { content: text };
      state.chunkIndex++;
      state.openText = true;
      out.push(makeChunk(state, delta));
      break;
    }
    case "reasoning-delta": {
      const text = event.text || "";
      if (!text) break;
      // Map reasoning to OpenAI "reasoning_content" field (used by deepseek-reasoner-style clients).
      const delta = reasoningDelta(text, state.chunkIndex === 0);
      state.chunkIndex++;
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-input-start": {
      const id = event.id || event.toolCallId || fallbackToolCallId(state.toolIndex);
      let idx = state.toolIndexById.get(id);
      if (idx == null) {
        idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
      }
      state.openTools.add(id);
      if (!state.toolArgBytes.has(id)) state.toolArgBytes.set(id, 0);
      const delta = {
        ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
        tool_calls: [{
          index: idx,
          id,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: event.toolName || "", arguments: "" },
        }],
      };
      state.chunkIndex++;
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-input-delta": {
      const id = event.id || event.toolCallId;
      const text = event.delta || event.inputTextDelta || "";
      const idx = state.toolIndexById.get(id);
      if (idx == null) {
        // The matching tool-input-start is missing, so the tool name is still unknown.
        // Emitting a nameless tool block here would be rejected downstream; hold the text
        // and let the consolidated tool-call below emit name + full input together.
        state.pendingArgText.set(id, (state.pendingArgText.get(id) || "") + text);
        break;
      }
      state.toolArgBytes.set(id, (state.toolArgBytes.get(id) || 0) + text.length);
      const delta = {
        tool_calls: [{
          index: idx,
          function: { arguments: text },
        }],
      };
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-call": {
      // Consolidated tool call. `event.input` is the authoritative full argument object:
      // emit it whenever no argument bytes were streamed for this id, otherwise the call
      // reaches the client with empty arguments (Claude Code then rejects it with
      // "required parameter is missing") instead of failing here.
      const id = event.toolCallId;
      const streamed = state.toolArgBytes.get(id) || 0;
      if (state.toolIndexById.has(id) && streamed > 0) break;
      let idx = state.toolIndexById.get(id);
      if (idx == null) {
        idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
      }
      const pending = state.pendingArgText.get(id) || "";
      const argsStr = typeof event.input === "string"
        ? event.input
        : event.input != null
          ? JSON.stringify(event.input)
          : (pending || "{}");
      state.pendingArgText.delete(id);
      state.toolArgBytes.set(id, (state.toolArgBytes.get(id) || 0) + argsStr.length);
      const delta = {
        ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
        tool_calls: [{
          index: idx,
          id,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: event.toolName || "", arguments: argsStr },
        }],
      };
      state.chunkIndex++;
      out.push(makeChunk(state, delta));
      break;
    }
    case "tool-input-error": {
      // AI SDK emits this when the model produced tool arguments that failed schema
      // validation / could not be repaired. It used to fall through to `default` and be
      // dropped, which left the already-opened tool block with no arguments at all —
      // the client then saw a tool call with `{}` and rejected it on required params.
      const id = event.toolCallId || event.id || fallbackToolCallId(state.toolIndex);
      const streamed = state.toolArgBytes.get(id) || 0;
      const hasInput = event.input !== undefined && event.input !== null;
      if (hasInput && streamed === 0) {
        const idx = state.toolIndexById.get(id) ?? (() => {
          const next = state.toolIndex++;
          state.toolIndexById.set(id, next);
          return next;
        })();
        const argsStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input);
        state.toolArgBytes.set(id, argsStr.length);
        out.push(makeChunk(state, {
          tool_calls: [{
            index: idx,
            id,
            type: OPENAI_BLOCK.FUNCTION,
            function: { name: event.toolName || "", arguments: argsStr },
          }],
        }));
        break;
      }
      const reason = event.errorText || event.error?.message || "tool input could not be parsed";
      throw new Error(`[CommandCode error: ${reason}]`);
    }
    case "finish-step": {
      state.finishReason = mapFinishReason(event.finishReason);
      if (event.usage) state.usage = event.usage;
      break;
    }
    case "finish": {
      const finishReason = state.finishReason || mapFinishReason(event.finishReason || "stop");
      const finalChunk = makeChunk(state, {}, finishReason);
      const totalUsage = event.totalUsage || state.usage;
      const usage = toOpenAIUsage(totalUsage, "commandcode");
      if (usage) finalChunk.usage = usage;
      out.push(finalChunk);
      break;
    }
    case "error": {
      const errVal = event.error ?? event.message ?? "unknown";
      const errStr = typeof errVal === "string" ? errVal : JSON.stringify(errVal);
      // Mid-stream error: throw rather than emitting as fake content with finish_reason: "stop"
      // This ensures the downstream stream handler marks the stream as errored/aborted.
      throw new Error(`[CommandCode error: ${errStr}]`);
    }
    // Silently ignore: start, start-step, reasoning-start, reasoning-end, text-start, text-end,
    // provider-metadata, message-metadata, etc. They carry no client-visible content.
    default:
      break;
  }

  return out.length ? out : null;
}

register(FORMATS.COMMANDCODE, FORMATS.OPENAI, null, commandCodeToOpenAIResponse);
