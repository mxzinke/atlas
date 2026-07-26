# WebUI Chat Rework — Build Spec

Goal: replace the janky poll-based HTMX chat with a smooth, streaming, well-organized chat — **reusing the existing backend** (message model, trigger firing, JSONL parsing, and the already-built SSE token stream).

## Key facts (from the current code)

- Two chat surfaces exist in `app/web-ui/index.ts`:
  - **HTMX page** `/chat*` — polls `GET /chat/conversation` every 2s, full innerHTML swap, NO token streaming. **This is what we replace.**
  - **JSON+SSE API** `/api/v1/chat/*` (guarded by `apiKeyAuth`, ATLAS_API_KEY) — used by an *external* frontend. `GET /api/v1/chat/stream` already emits real token deltas. **Do not break it.**
- `/chat*` (app router) has **no auth** (perimeter-trusted). `/api/v1/*` requires the API key. Browser client must stay keyless → new streaming/snapshot/send endpoints go on the **app router under `/chat/...`, no key**.
- Session model: `messages` (user turns only, channel='web', session_key), `chat_sessions` (session_key PK, title, archived_at; `_default` always present, never archivable/deletable), `trigger_sessions` (session_key↔Claude session_id/JSONL), `web_chat_stream_chunks` (live token deltas: session_id, message_uuid=Anthropic message.id, chunk_index, content_delta).
- Assistant/tool/thinking content comes from the JSONL transcript (`parseSessionMessages` + `findSessionFile`), NOT the DB. User `user-text` JSONL entries are filtered out (DB is ground truth for user turns).
- Send flow: `POST` inserts into `messages`, touches wake file, `Bun.spawn(trigger.sh, "web-chat", payload, sessionKey)` fire-and-forget. Persistent session → message injected into the running Claude process via IPC socket; else a new run spawns. `persistStreamChunk` writes token deltas to `web_chat_stream_chunks`.
- `isAgentRunning = (!session && dbMessages.length>0) || (!!session && (isClaudeProcessRunning(session_id) || isAgentTurnActive(jsonl)))`.
- `sqliteToIso()` MUST wrap any raw SQLite `created_at` (UTC without tz) or timestamps render 1-2h off. JSONL timestamps are already ISO-Z.

## Existing SSE event contract (from `/api/v1/chat/stream`, mirror it on the app router)
- `init` `{messages:[{role,content,timestamp,toolName?}], isAgentRunning, toolSteps}` (once, on connect; seeds lastChunkId so it does NOT replay old chunks).
- `user_message` `{content, timestamp}`
- `assistant_message_chunk` `{messageId, index, delta}` — concatenate by messageId in index order into a live bubble.
- `assistant_message` `{content, timestamp, messageId?}` — final block; replace the streamed bubble matched by messageId (fallback: append if no messageId).
- `tool_activity` `{toolName, totalSteps}` — name + counter only (no input/output).
- `agent_started` `{}` / `agent_ended` `{}` (close is delayed 1.5s after agent_ended). Server self-caps at 5 min (MAX_POLLS 600 × 500ms) → client MUST reconnect if still running.

## What to build

### Backend (app router, no API key; reuse existing helpers — do not duplicate logic, extract shared functions)
1. `GET /chat/stream?sessionKey=` — SSE, identical event contract to `/api/v1/chat/stream`. Extract the existing stream handler into a shared function and mount it on both routers.
2. `GET /chat/api/messages?sessionKey=` — JSON snapshot for initial load & tool detail: `{messages, isAgentRunning}` where messages includes **grouped tool calls WITH input/result** (reuse `renderConversation`'s grouping logic but return structured JSON, not HTML: assistant-text, thinking, and toolGroup:[{name,input,result}]). This fills the gap that SSE `tool_activity` lacks tool I/O.
3. `POST /chat/api/messages` — JSON send: body `{content}`, returns the inserted user message; fires the trigger exactly like the current `POST /chat`. Keep the existing form-based `POST /chat` working OR redirect it — but the new frontend uses this JSON endpoint.
4. Session CRUD for the new UI: reuse existing `/chat/sessions/*` (new/rename/archive/delete) — they already return sidebar fragments; add small JSON variants if cleaner, or have the frontend call a `GET /chat/api/sessions` JSON list. Keep `_default` special-casing.

### Frontend (buildless: one self-contained page served at `GET /chat` — inline HTML + CSS + vanilla JS; no framework/build step, consistent with the repo)
Requirements — make it feel fast, smooth, and clear:
- **Real token streaming**: consume `GET /chat/stream` via `EventSource`. Render `assistant_message_chunk` deltas live into a growing bubble (keyed by messageId). Finalize on `assistant_message`.
- **No teardown flicker**: patch the DOM incrementally (append new bubbles, update the streaming bubble in place). NEVER innerHTML-replace the whole message list on updates. Expanded tool/thinking sections must stay expanded across updates.
- **Tool calls**: render as compact, collapsible steps with tool name; expandable to show input + result (from the JSON snapshot; refresh tool detail via `GET /chat/api/messages` when a turn finishes). Group a turn's tool calls cleanly. Show a running step indicator while the agent works.
- **Smart autoscroll**: stick to bottom only when the user is already at/near bottom. If scrolled up, do NOT snap; show a "↓ New messages" pill that scrolls to bottom on click.
- **Running/typing state**: driven by agent_started/agent_ended + isAgentRunning from init; show a subtle typing indicator. On SSE close while still running, reconnect (fresh EventSource) with small backoff; re-sync via snapshot to avoid dup/orphan bubbles.
- **Markdown for assistant text**: render markdown + code blocks (use a tiny buildless lib via CDN, e.g. `marked` + `DOMPurify`, or a minimal safe renderer). User text: escape, preserve newlines.
- **Session sidebar / overview**: clear list (title, last activity, message count), active highlight, new/rename/archive/delete, `_default` protected. Better visual hierarchy than today.
- **Robustness against the mapped footguns**: handle missing messageId (append vs. replace), avoid duplicate bubbles when snapshot + stream overlap (reconcile by messageId/timestamp), keep timestamps correct (sqliteToIso on DB rows).
- **Design**: clean, modern dark theme consistent with the existing dashboard palette (bg #1a1b2e, accent #7c6ef0). Good spacing, readable message bubbles, monospace for code/tool I/O. Mobile-friendly (sidebar collapses).

## Constraints
- Repo: `unclutter-pro/atlas` (remote `mxzinke/atlas`). Branch off master; **PR only, no direct push to master, no merge, no auto-merge.** Git author `Atlas (by M. Pfennig) <max@coin-mirror.org>`.
- Bun, no build step. Keep it buildless.
- Don't break `/api/v1/chat/*` (external frontend depends on it).
- Add/adjust tests (`bun test` in app/web-ui) for new backend endpoints. Existing 251 trigger tests + web-ui tests must stay green.
- Keep the existing DB schema; no destructive migrations.
