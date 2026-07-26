/*
 * Buildless vanilla-JS chat client for GET /chat.
 * Talks to the keyless app-router endpoints:
 *   GET  /chat/api/messages?sessionKey=   -> snapshot (full tool detail)
 *   GET  /chat/stream?sessionKey=         -> SSE token stream
 *   POST /chat/api/messages               -> send
 *   GET  /chat/api/sessions               -> sidebar list
 *   POST /chat/sessions/new, PATCH/POST/DELETE /chat/sessions/:key
 *
 * Design constraints (see docs/chat-rework-spec.md):
 *  - never innerHTML-replace the whole message list on updates
 *  - reconcile snapshot + SSE by messageId / content+timestamp, no dup bubbles
 *  - smart autoscroll with a "new messages" pill when scrolled up
 *  - reconnect the EventSource with backoff, re-sync via snapshot
 */
(function () {
  "use strict";

  var root = document.getElementById("cw-root");
  var messagesEl = document.getElementById("cw-messages");
  var scrollPillEl = document.getElementById("cw-scroll-pill");
  var inputEl = document.getElementById("cw-input");
  var sendBtn = document.getElementById("cw-send");
  var sidebarListEl = document.getElementById("cw-sidebar-list");
  var newChatBtn = document.getElementById("cw-new-chat");
  var sidebarEl = document.getElementById("cw-sidebar");
  var mobileToggleEl = document.getElementById("cw-mobile-toggle");
  var reconnectBadgeEl = document.getElementById("cw-reconnecting");
  var agentName = root.dataset.agentName || "Atlas";

  // ---- state -------------------------------------------------------------

  var sessionKey = root.dataset.sessionKey;
  var es = null; // current EventSource
  var esIntentionalClose = false;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var isAgentRunning = false;

  /** key -> wrapper element, for dedupe between snapshot + stream */
  var renderedKeys = new Map();
  /** messageId -> {wrapperEl, contentEl, buffer, rafScheduled, finalized} */
  var streamingBubbles = new Map();
  /** recently-sent-by-me content+timestamp keys, set right after POST succeeds */
  var typingEl = null;
  var toolRunningEl = null;
  var toolStepCount = 0;

  // ---- utils ---------------------------------------------------------------

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var diffMs = Date.now() - t;
    var m = Math.floor(diffMs / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function truncate(s, n) {
    s = s || "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function renderMarkdownInto(el, text) {
    text = text || "";
    if (window.marked && window.DOMPurify) {
      try {
        var html = window.DOMPurify.sanitize(window.marked.parse(text));
        el.innerHTML = html;
        return;
      } catch (e) {
        /* fall through to plain text */
      }
    }
    el.textContent = text;
    el.style.whiteSpace = "pre-wrap";
  }

  // ---- scroll handling -------------------------------------------------

  var SCROLL_THRESHOLD = 80;

  function isNearBottom() {
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      SCROLL_THRESHOLD
    );
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    hideScrollPill();
  }

  function showScrollPill() {
    scrollPillEl.hidden = false;
  }

  function hideScrollPill() {
    scrollPillEl.hidden = true;
  }

  /** Appends a node, preserving scroll position unless the user was already
   *  pinned to the bottom (spec: smart autoscroll). */
  function appendNode(node) {
    var stick = isNearBottom();
    messagesEl.appendChild(node);
    if (stick) {
      scrollToBottom();
    } else {
      showScrollPill();
    }
  }

  messagesEl.addEventListener("scroll", function () {
    if (isNearBottom()) hideScrollPill();
  });
  scrollPillEl.addEventListener("click", scrollToBottom);

  // ---- message node builders --------------------------------------------

  function keyForUser(content, timestamp) {
    return "user:" + timestamp + ":" + content;
  }
  function keyForAssistant(messageId, content, timestamp) {
    return messageId ? "asst-id:" + messageId : "asst:" + timestamp + ":" + content;
  }
  function keyForThinking(timestamp, content) {
    return "think:" + timestamp + ":" + truncate(content, 40);
  }
  function keyForToolGroup(timestamp, calls) {
    var names = calls.map(function (c) { return c.name; }).join(",");
    return "tools:" + timestamp + ":" + names;
  }

  function buildUserBubble(content, timestamp) {
    var wrap = document.createElement("div");
    wrap.className = "cw-row cw-row-user";
    var bubble = document.createElement("div");
    bubble.className = "cw-bubble cw-bubble-user";
    bubble.style.whiteSpace = "pre-wrap";
    bubble.textContent = content;
    wrap.appendChild(bubble);
    if (timestamp) {
      var t = document.createElement("div");
      t.className = "cw-time cw-time-user";
      t.textContent = timeAgo(timestamp);
      wrap.appendChild(t);
    }
    return wrap;
  }

  function buildAssistantBubble(content, timestamp) {
    var wrap = document.createElement("div");
    wrap.className = "cw-row cw-row-bot";
    var bubble = document.createElement("div");
    bubble.className = "cw-bubble cw-bubble-bot";
    var contentEl = document.createElement("div");
    contentEl.className = "cw-markdown";
    renderMarkdownInto(contentEl, content);
    bubble.appendChild(contentEl);
    wrap.appendChild(bubble);
    if (timestamp) {
      var t = document.createElement("div");
      t.className = "cw-time";
      t.textContent = timeAgo(timestamp);
      wrap.appendChild(t);
    }
    return { wrap: wrap, contentEl: contentEl };
  }

  function buildThinking(content) {
    var wrap = document.createElement("div");
    wrap.className = "cw-row cw-row-bot cw-thinking-row";
    var details = document.createElement("details");
    details.className = "cw-thinking";
    var summary = document.createElement("summary");
    summary.textContent = "thinking";
    var pre = document.createElement("pre");
    pre.textContent = content;
    details.appendChild(summary);
    details.appendChild(pre);
    wrap.appendChild(details);
    return wrap;
  }

  function buildToolGroup(calls) {
    var wrap = document.createElement("div");
    wrap.className = "cw-row cw-row-bot cw-tool-row";
    var details = document.createElement("details");
    details.className = "cw-tool";
    var summary = document.createElement("summary");
    summary.textContent =
      calls.length === 1
        ? calls[0].name
        : calls.length + " tool calls: " + calls.map(function (c) { return c.name; }).join(", ");
    details.appendChild(summary);
    calls.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "cw-tool-item";
      var name = document.createElement("div");
      name.className = "cw-tool-name";
      name.textContent = t.name;
      item.appendChild(name);
      var input = document.createElement("pre");
      input.className = "cw-tool-input";
      input.textContent = truncate(t.input || "", 2000);
      item.appendChild(input);
      if (t.result) {
        var result = document.createElement("pre");
        result.className = "cw-tool-result";
        result.textContent = truncate(t.result, 2000);
        item.appendChild(result);
      }
      details.appendChild(item);
    });
    wrap.appendChild(details);
    return wrap;
  }

  function buildToolRunning() {
    var wrap = document.createElement("div");
    wrap.className = "cw-row cw-row-bot cw-tool-running";
    var pill = document.createElement("div");
    pill.className = "cw-tool-running-pill";
    var spinner = document.createElement("span");
    spinner.className = "cw-spinner";
    pill.appendChild(spinner);
    var label = document.createElement("span");
    label.className = "cw-tool-running-label";
    pill.appendChild(label);
    wrap.appendChild(pill);
    wrap._label = label;
    return wrap;
  }

  function buildTyping() {
    var wrap = document.createElement("div");
    wrap.className = "cw-row cw-row-bot";
    var dots = document.createElement("div");
    dots.className = "cw-typing";
    dots.innerHTML = "<span></span><span></span><span></span>";
    wrap.appendChild(dots);
    return wrap;
  }

  // ---- ephemeral indicators (typing / running-tool) ---------------------

  function showTyping() {
    if (typingEl || toolRunningEl) return;
    typingEl = buildTyping();
    appendNode(typingEl);
  }

  function clearTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function updateToolRunning(toolName, totalSteps) {
    clearTyping();
    toolStepCount = totalSteps;
    if (!toolRunningEl) {
      toolRunningEl = buildToolRunning();
      appendNode(toolRunningEl);
    }
    toolRunningEl._label.textContent =
      "Running " + toolName + " · step " + totalSteps;
  }

  function clearToolRunning() {
    if (toolRunningEl) {
      toolRunningEl.remove();
      toolRunningEl = null;
    }
  }

  // ---- rendering items from the JSON snapshot ----------------------------

  function renderSnapshotItem(item) {
    if (item.kind === "user") {
      var k = keyForUser(item.content, item.timestamp);
      if (renderedKeys.has(k)) return;
      var node = buildUserBubble(item.content, item.timestamp);
      renderedKeys.set(k, node);
      appendNode(node);
    } else if (item.kind === "assistant") {
      var ak = keyForAssistant(item.messageId, item.content, item.timestamp);
      if (renderedKeys.has(ak)) return;
      // If this assistant message is currently streaming (or streamed and
      // waiting for the final SSE event), finalize the existing bubble in
      // place instead of creating a duplicate one.
      if (item.messageId && streamingBubbles.has(item.messageId)) {
        var sb = streamingBubbles.get(item.messageId);
        renderMarkdownInto(sb.contentEl, item.content);
        sb.finalized = true;
        renderedKeys.set(ak, sb.wrap);
        return;
      }
      var built = buildAssistantBubble(item.content, item.timestamp);
      renderedKeys.set(ak, built.wrap);
      appendNode(built.wrap);
    } else if (item.kind === "thinking") {
      var tk = keyForThinking(item.timestamp, item.content);
      if (renderedKeys.has(tk)) return;
      var tnode = buildThinking(item.content);
      renderedKeys.set(tk, tnode);
      appendNode(tnode);
    } else if (item.kind === "tool_group") {
      var gk = keyForToolGroup(item.timestamp, item.calls);
      if (renderedKeys.has(gk)) return;
      var gnode = buildToolGroup(item.calls);
      renderedKeys.set(gk, gnode);
      appendNode(gnode);
    }
  }

  // ---- snapshot load / reconcile -----------------------------------------

  function setRunningState(running) {
    isAgentRunning = running;
    root.classList.toggle("cw-running", running);
    sendBtn.title = running
      ? agentName + " is working — your message will be queued"
      : "Send";
  }

  function fetchSnapshot() {
    return fetch("/chat/api/messages?sessionKey=" + encodeURIComponent(sessionKey))
      .then(function (r) { return r.json(); });
  }

  /** Initial load: full render (list is empty, so this is just append-only). */
  function loadInitialSnapshot() {
    return fetchSnapshot().then(function (data) {
      (data.items || []).forEach(renderSnapshotItem);
      setRunningState(!!data.isAgentRunning);
      if (isAgentRunning) showTyping();
      // First paint: always land at the bottom.
      scrollToBottom();
    });
  }

  /** Re-sync point used after agent_ended and on reconnect. Only appends/
   *  patches — never clears the list, so open <details> stay open. */
  function reconcileSnapshot() {
    return fetchSnapshot().then(function (data) {
      (data.items || []).forEach(renderSnapshotItem);
      setRunningState(!!data.isAgentRunning);
      if (!isAgentRunning) {
        clearTyping();
        clearToolRunning();
      }
    }).catch(function () {});
  }

  // ---- SSE stream ----------------------------------------------------------

  function getOrCreateStreamingBubble(messageId) {
    var sb = streamingBubbles.get(messageId);
    if (sb) return sb;
    clearTyping();
    var built = buildAssistantBubble("", null);
    appendNode(built.wrap);
    sb = {
      wrap: built.wrap,
      contentEl: built.contentEl,
      buffer: "",
      rafScheduled: false,
      finalized: false,
    };
    streamingBubbles.set(messageId, sb);
    return sb;
  }

  function scheduleStreamRender(sb) {
    if (sb.rafScheduled) return;
    sb.rafScheduled = true;
    requestAnimationFrame(function () {
      sb.rafScheduled = false;
      if (sb.finalized) return;
      var stick = isNearBottom();
      renderMarkdownInto(sb.contentEl, sb.buffer);
      if (stick) scrollToBottom();
    });
  }

  function connectStream() {
    if (es) {
      esIntentionalClose = true;
      es.close();
    }
    esIntentionalClose = false;
    es = new EventSource("/chat/stream?sessionKey=" + encodeURIComponent(sessionKey));

    es.addEventListener("open", function () {
      reconnectDelay = 1000;
      if (reconnectBadgeEl) reconnectBadgeEl.hidden = true;
    });

    es.addEventListener("init", function (ev) {
      try {
        var data = JSON.parse(ev.data);
        setRunningState(!!data.isAgentRunning);
        if (isAgentRunning) showTyping();
      } catch (e) {}
    });

    es.addEventListener("user_message", function (ev) {
      try {
        var data = JSON.parse(ev.data);
        var k = keyForUser(data.content, data.timestamp);
        if (renderedKeys.has(k)) return;
        var node = buildUserBubble(data.content, data.timestamp);
        renderedKeys.set(k, node);
        appendNode(node);
      } catch (e) {}
    });

    es.addEventListener("assistant_message_chunk", function (ev) {
      try {
        var data = JSON.parse(ev.data);
        var sb = getOrCreateStreamingBubble(data.messageId);
        if (sb.finalized) return;
        sb.buffer += data.delta || "";
        scheduleStreamRender(sb);
      } catch (e) {}
    });

    es.addEventListener("assistant_message", function (ev) {
      try {
        var data = JSON.parse(ev.data);
        var mid = data.messageId;
        if (mid && streamingBubbles.has(mid)) {
          var sb = streamingBubbles.get(mid);
          sb.finalized = true;
          renderMarkdownInto(sb.contentEl, data.content);
          renderedKeys.set(keyForAssistant(mid, data.content, data.timestamp), sb.wrap);
          if (isNearBottom()) scrollToBottom();
          return;
        }
        var ak = keyForAssistant(mid, data.content, data.timestamp);
        if (renderedKeys.has(ak)) return;
        clearTyping();
        var built = buildAssistantBubble(data.content, data.timestamp);
        renderedKeys.set(ak, built.wrap);
        appendNode(built.wrap);
      } catch (e) {}
    });

    es.addEventListener("tool_activity", function (ev) {
      try {
        var data = JSON.parse(ev.data);
        updateToolRunning(data.toolName, data.totalSteps);
      } catch (e) {}
    });

    es.addEventListener("agent_started", function () {
      setRunningState(true);
      showTyping();
    });

    es.addEventListener("agent_ended", function () {
      setRunningState(false);
      clearTyping();
      clearToolRunning();
      // Tool input/output and the final assistant text aren't fully known
      // from SSE alone (tool_activity carries no I/O) — pull the authoritative
      // grouped view once the turn is done.
      reconcileSnapshot();
      // Refresh sidebar message counts/last-activity now that the turn settled.
      loadSessions();
    });

    es.addEventListener("error", function () {
      if (esIntentionalClose) return;
      if (reconnectBadgeEl) reconnectBadgeEl.hidden = false;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconcileSnapshot().then(connectStream);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
  }

  function closeStream() {
    if (es) {
      esIntentionalClose = true;
      es.close();
      es = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // ---- composer -----------------------------------------------------------

  function autoGrow() {
    inputEl.style.height = "auto";
    var max = 200;
    inputEl.style.height = Math.min(inputEl.scrollHeight, max) + "px";
  }

  function sendMessage() {
    var content = inputEl.value.trim();
    if (!content) return;
    inputEl.value = "";
    autoGrow();
    inputEl.focus();

    fetch("/chat/api/messages?sessionKey=" + encodeURIComponent(sessionKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.message) return;
        var k = keyForUser(data.message.content, data.message.timestamp);
        if (renderedKeys.has(k)) return; // optimistic-echo race: already rendered
        var node = buildUserBubble(data.message.content, data.message.timestamp);
        renderedKeys.set(k, node);
        appendNode(node);
        showTyping();
      })
      .catch(function () {
        /* leave the textarea cleared; the periodic reconcile will catch up */
      });
  }

  inputEl.addEventListener("input", autoGrow);
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener("click", sendMessage);

  // ---- sidebar --------------------------------------------------------------

  function renderSidebar(sessions) {
    sidebarListEl.textContent = "";
    if (!sessions.length) {
      var empty = document.createElement("div");
      empty.className = "cw-sidebar-empty";
      empty.textContent = "No chats yet.";
      sidebarListEl.appendChild(empty);
      return;
    }
    sessions.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "cw-session" + (s.session_key === sessionKey ? " active" : "");
      row.dataset.key = s.session_key;

      var link = document.createElement("a");
      link.className = "cw-session-link";
      link.href = "/chat?session=" + encodeURIComponent(s.session_key);
      var title = document.createElement("span");
      title.className = "cw-session-title";
      title.textContent = s.title && s.title.trim()
        ? s.title
        : (s.session_key === "_default" ? "Default" : "Untitled chat");
      var meta = document.createElement("span");
      meta.className = "cw-session-meta";
      meta.textContent =
        (s.message_count || 0) + " msg" + (s.last_message_at ? " · " + timeAgo(s.last_message_at) : "");
      link.appendChild(title);
      link.appendChild(meta);
      link.addEventListener("click", function (e) {
        e.preventDefault();
        switchSession(s.session_key);
      });
      row.appendChild(link);

      var actions = document.createElement("span");
      actions.className = "cw-session-actions";

      var renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.title = "Rename";
      renameBtn.textContent = "✎";
      renameBtn.addEventListener("click", function (e) {
        e.preventDefault();
        startRename(row, s);
      });
      actions.appendChild(renameBtn);

      if (s.session_key !== "_default") {
        var archiveBtn = document.createElement("button");
        archiveBtn.type = "button";
        archiveBtn.title = "Archive";
        archiveBtn.textContent = "📥";
        archiveBtn.addEventListener("click", function (e) {
          e.preventDefault();
          archiveSession(s.session_key);
        });
        actions.appendChild(archiveBtn);

        var deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.title = "Delete";
        deleteBtn.textContent = "🗑";
        deleteBtn.addEventListener("click", function (e) {
          e.preventDefault();
          if (confirm("Delete this chat? This cannot be undone.")) {
            deleteSession(s.session_key);
          }
        });
        actions.appendChild(deleteBtn);
      }

      row.appendChild(actions);
      sidebarListEl.appendChild(row);
    });
  }

  function startRename(row, s) {
    row.textContent = "";
    var form = document.createElement("form");
    form.className = "cw-session-rename";
    var input = document.createElement("input");
    input.type = "text";
    input.value = s.title || "";
    input.placeholder = "Title…";
    form.appendChild(input);
    var save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save";
    form.appendChild(save);
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cw-btn-outline";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function () { loadSessions(); });
    form.appendChild(cancel);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      renameSession(s.session_key, input.value.trim());
    });
    row.appendChild(form);
    input.focus();
  }

  function loadSessions() {
    return fetch("/chat/api/sessions")
      .then(function (r) { return r.json(); })
      .then(function (data) { renderSidebar(data.sessions || []); })
      .catch(function () {});
  }

  function extractRedirectKey(res) {
    var loc = res.headers.get("HX-Redirect");
    if (!loc) return null;
    try {
      var u = new URL(loc, window.location.origin);
      return u.searchParams.get("session");
    } catch (e) {
      return null;
    }
  }

  function newSession() {
    fetch("/chat/sessions/new", { method: "POST" }).then(function (res) {
      var key = extractRedirectKey(res);
      if (key) switchSession(key);
      loadSessions();
    });
  }

  function renameSession(key, title) {
    var body = new URLSearchParams();
    body.set("title", title);
    fetch("/chat/sessions/" + encodeURIComponent(key), { method: "PATCH", body: body })
      .then(function () { loadSessions(); });
  }

  function archiveSession(key) {
    fetch("/chat/sessions/" + encodeURIComponent(key) + "/archive", { method: "POST" }).then(function (res) {
      var redirectKey = extractRedirectKey(res);
      if (redirectKey || key === sessionKey) {
        switchSession("_default");
      }
      loadSessions();
    });
  }

  function deleteSession(key) {
    fetch("/chat/sessions/" + encodeURIComponent(key), { method: "DELETE" }).then(function (res) {
      var redirectKey = extractRedirectKey(res);
      if (redirectKey || key === sessionKey) {
        switchSession("_default");
      }
      loadSessions();
    });
  }

  newChatBtn.addEventListener("click", newSession);

  if (mobileToggleEl) {
    mobileToggleEl.addEventListener("click", function () {
      sidebarEl.classList.toggle("cw-sidebar-open");
    });
  }
  if (sidebarEl) {
    sidebarEl.addEventListener("click", function (e) {
      if (e.target.closest(".cw-session-link") && window.innerWidth <= 760) {
        sidebarEl.classList.remove("cw-sidebar-open");
      }
    });
  }

  // ---- session switching -----------------------------------------------

  function resetMessageState() {
    messagesEl.textContent = "";
    renderedKeys.clear();
    streamingBubbles.clear();
    typingEl = null;
    toolRunningEl = null;
    toolStepCount = 0;
    hideScrollPill();
  }

  function switchSession(key) {
    if (key === sessionKey && es) return;
    closeStream();
    sessionKey = key;
    root.dataset.sessionKey = key;
    var url = new URL(window.location.href);
    url.searchParams.set("session", key);
    window.history.pushState({}, "", url);
    resetMessageState();
    loadInitialSnapshot().then(connectStream);
    loadSessions();
  }

  window.addEventListener("popstate", function () {
    var url = new URL(window.location.href);
    var key = url.searchParams.get("session") || "_default";
    if (key !== sessionKey) switchSession(key);
  });

  // ---- boot ---------------------------------------------------------------

  autoGrow();
  loadSessions();
  loadInitialSnapshot().then(connectStream);
})();
