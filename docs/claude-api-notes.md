# Claude API notes (verified Oct 13 2026 against the bundled claude-api skill)

SDK: `@anthropic-ai/sdk` (installed in packages/narrator). Model: `claude-opus-5-5`.

## Hard facts for claude-opus-5-5
- Thinking is always on. Do NOT send `thinking: {type: "disabled"}` or `budget_tokens` (both 400). Omit `thinking` or send `{ type: "adaptive" }`.
- Control depth with `output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }`. Default is `medium`; set it explicitly. Narration: `low`. Revisions: `medium`.
- Forced tool choice (`tool_choice: {type: "any"}` or `{type: "tool", ...}`) returns 400. Use `tool_choice: {type: "auto"}` (the default), name the tool in the prompt, and set `strict: true` on each tool (schema needs `additionalProperties: false` and `required`). `auto` does not guarantee a call: check for a `tool_use` block and re-prompt once if none came back.
- No assistant prefill (400).
- Structured output: `client.messages.parse({ ..., output_config: { format: zodOutputFormat(Schema) } })` with `import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`; read `response.parsed_output` (null if parsing failed: guard it). Do not use the deprecated `output_format` param.
- Refusals: HTTP 200 with `stop_reason: "refusal"`. Always check `stop_reason` before reading `content`. `stop_details` may be null.
- Server-side fallback (enable by default): `client.beta.messages.create({ ..., betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`. The array form uses a different header (`server-side-fallback-2026-06-01`); never mix them. If the beta path does not type-check with `parse`, call `beta.messages.create` with `output_config.format` and parse the text yourself, or keep fallbacks on the non-parse path. Fallbacks are rejected on the Batches API.
- Response content is a discriminated union: narrow `block.type === "text"` before `.text`. Thinking blocks come back with empty text by default (`display: "omitted"`).
- Tool input JSON: always `JSON.parse` / use the SDK's parsed `input`; never string-match.
- Errors: catch most-specific-first: `Anthropic.BadRequestError`, `Anthropic.AuthenticationError`, `Anthropic.RateLimitError`, `Anthropic.APIError`. SDK retries 408/409/429/5xx twice by default.
- `max_tokens`: ~16000 for non-streaming. Streaming helper: `client.messages.stream(...).finalMessage()`.
- Prompt caching: put `cache_control: { type: "ephemeral" }` on the frozen system prompt block. Never put timestamps or per-request ids in the system prompt.
- Credentials: `new Anthropic()` reads `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile). Never hardcode.

## Manual tool loop shape (TypeScript)
```ts
const response = await client.messages.create({ model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "medium" }, tools: tools.map(t => ({ ...t, strict: true })), messages });
if (response.stop_reason === "refusal") { /* handle */ }
for (const block of response.content) {
  if (block.type === "tool_use") { /* run tool, push ONE user message with ALL tool_result blocks */ }
}
```
Parallel tool calls: return every `tool_result` in a single user message; on tool failure send `is_error: true`, never drop it.

## OpenRouter route (Oct 20 2026)

When `OPENROUTER_API_KEY` is set, `createNarratorClient` returns `createOpenRouterClient` (`packages/narrator/src/openrouter.ts`) instead of the SDK. It posts to `https://openrouter.ai/api/v1/chat/completions` with model `anthropic/claude-opus-5.5` and translates the Messages request: system blocks (with `cache_control`), turns, strict function tools, `tool_choice: "auto"`, `response_format: json_schema` from `output_config.format`, `verbosity` from `output_config.effort`, `provider.require_parameters: true`. Tool results become `tool` messages (`is_error` as an `Error: ` prefix). `betas` / `fallbacks` are not sent: the server-side refusal fallback exists only on the Anthropic route. The feature table is in `packages/narrator/README.md` ("Providers"); `npm run llm:check` checks tools, the is_error loop and structured output live.
