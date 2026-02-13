(() => {
  if (window.ChatKBWidget?.version) {
    return;
  }

  const VERSION = "0.1.0";
  const DEFAULTS = {
    position: "right",
    primaryColor: "#2563eb",
    welcomeText: "Ask a question about this knowledge base.",
    title: "Knowledge Base Assistant",
    launcherLabel: "Chat",
    placeholder: "Ask a question...",
    apiBase: "",
  };

  function coalesce(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return "";
  }

  function parseJsonResponse(response) {
    return response
      .json()
      .catch(() => ({ error: { code: "invalid_json_response", message: "Invalid JSON response." } }));
  }

  function inferApiBase(scriptEl) {
    try {
      const scriptUrl = new URL(scriptEl.src, window.location.href);
      return `${scriptUrl.origin}/functions/v1`;
    } catch {
      return "";
    }
  }

  function toEndpoint(base, functionName) {
    const normalized = (base || "").replace(/\/+$/, "");
    return `${normalized}/${functionName}`;
  }

  function citationLabel(citation) {
    if (!citation || typeof citation !== "object") return "Source";
    const title = typeof citation.title === "string" && citation.title ? citation.title : "Source";
    const parts = [];
    if (typeof citation.page === "number") parts.push(`p.${citation.page}`);
    if (typeof citation.slide === "number") parts.push(`slide ${citation.slide}`);
    return parts.length ? `${title} (${parts.join(", ")})` : title;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (typeof text === "string") element.textContent = text;
    return element;
  }

  function createWidget(options) {
    const state = {
      open: false,
      embedToken: "",
      expiresAtMs: 0,
      loadingSession: false,
      awaitingChat: false,
      messagesRendered: 0,
    };

    const root = createElement("div", "chatkb-widget");
    root.setAttribute("data-chatkb-position", options.position === "left" ? "left" : "right");
    root.style.setProperty("--chatkb-primary", options.primaryColor);

    const bubble = createElement("button", "chatkb-bubble", options.launcherLabel);
    bubble.type = "button";
    bubble.setAttribute("aria-expanded", "false");
    bubble.setAttribute("aria-label", "Open chat");

    const panel = createElement("section", "chatkb-panel");
    panel.hidden = true;

    const header = createElement("header", "chatkb-header");
    const title = createElement("strong", "chatkb-title", options.title);
    const closeButton = createElement("button", "chatkb-close", "Close");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close chat");
    header.append(title, closeButton);

    const errorBanner = createElement("div", "chatkb-error");
    errorBanner.hidden = true;

    const messageList = createElement("div", "chatkb-messages");
    const form = createElement("form", "chatkb-form");
    const input = document.createElement("input");
    input.className = "chatkb-input";
    input.name = "message";
    input.placeholder = options.placeholder;
    input.autocomplete = "off";
    input.required = true;
    const send = createElement("button", "chatkb-send", "Send");
    send.type = "submit";
    form.append(input, send);

    panel.append(header, errorBanner, messageList, form);
    root.append(panel, bubble);

    function appendMessage(role, text, citations) {
      const message = createElement("article", `chatkb-message chatkb-${role}`);
      message.append(createElement("p", "", text));

      if (Array.isArray(citations) && citations.length > 0) {
        const chips = createElement("div", "chatkb-citations");
        citations.forEach((citation) => {
          const chip = createElement("span", "chatkb-chip", citationLabel(citation));
          chips.append(chip);
        });
        message.append(chips);
      }

      messageList.append(message);
      state.messagesRendered += 1;
      messageList.scrollTop = messageList.scrollHeight;
    }

    function setError(message) {
      if (!message) {
        errorBanner.hidden = true;
        errorBanner.textContent = "";
        return;
      }
      errorBanner.hidden = false;
      errorBanner.textContent = message;
    }

    function mapSessionError(error) {
      const code = error?.code;
      if (code === "blocked_origin") return "This chat is not enabled for this website.";
      if (code === "rate_limited") return "Rate limit reached. Please try again shortly.";
      if (code === "quota_exceeded") return "This chat has reached its usage quota.";
      return "Chat is temporarily unavailable. Please try again later.";
    }

    async function initSession() {
      if (state.loadingSession) return false;
      if (!options.projectHandle) {
        setError("Widget is missing project configuration.");
        return false;
      }

      state.loadingSession = true;
      try {
        const response = await fetch(toEndpoint(options.apiBase, "embed_session"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project_handle: options.projectHandle }),
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok) {
          setError(mapSessionError(payload?.error));
          return false;
        }

        const token = payload?.data?.embed_token;
        const expiresAt = payload?.data?.expires_at;
        if (typeof token !== "string" || typeof expiresAt !== "string") {
          setError("Widget session response is invalid.");
          return false;
        }
        state.embedToken = token;
        state.expiresAtMs = Date.parse(expiresAt) || 0;
        setError("");
        if (state.messagesRendered === 0) {
          appendMessage("assistant", options.welcomeText, []);
        }
        return true;
      } catch {
        setError("Chat is temporarily unavailable. Please try again later.");
        return false;
      } finally {
        state.loadingSession = false;
      }
    }

    async function ensureActiveSession() {
      const now = Date.now();
      if (state.embedToken && state.expiresAtMs > now + 5000) {
        return true;
      }
      return initSession();
    }

    function mapChatError(error) {
      const code = error?.code;
      if (code === "blocked_origin") return "This chat is not enabled for this website.";
      if (code === "rate_limited") return "Rate limit reached. Please try again shortly.";
      if (code === "quota_exceeded") return "This chat has reached its usage quota.";
      return "Temporary failure. Please retry in a moment.";
    }

    async function sendMessage(message) {
      if (state.awaitingChat) return;
      state.awaitingChat = true;
      send.disabled = true;
      input.disabled = true;

      appendMessage("user", message, []);
      setError("");

      const hasSession = await ensureActiveSession();
      if (!hasSession) {
        state.awaitingChat = false;
        send.disabled = false;
        input.disabled = false;
        return;
      }

      try {
        const response = await fetch(toEndpoint(options.apiBase, "chat"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            embed_token: state.embedToken,
            message,
          }),
        });
        const payload = await parseJsonResponse(response);
        if (!response.ok) {
          setError(mapChatError(payload?.error));
          return;
        }

        const answer =
          typeof payload?.data?.answer === "string"
            ? payload.data.answer
            : "I could not generate an answer yet.";
        const citations = Array.isArray(payload?.data?.citations) ? payload.data.citations : [];
        appendMessage("assistant", answer, citations);
      } catch {
        setError("Temporary failure. Please retry in a moment.");
      } finally {
        state.awaitingChat = false;
        send.disabled = false;
        input.disabled = false;
        input.focus();
      }
    }

    function togglePanel(nextOpen) {
      state.open = nextOpen;
      panel.hidden = !nextOpen;
      bubble.setAttribute("aria-expanded", String(nextOpen));
      bubble.textContent = nextOpen ? "Close" : options.launcherLabel;
      if (nextOpen) {
        void ensureActiveSession();
      }
    }

    bubble.addEventListener("click", () => togglePanel(!state.open));
    closeButton.addEventListener("click", () => togglePanel(false));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      input.value = "";
      void sendMessage(value);
    });

    document.body.append(root);
    return {
      open: () => togglePanel(true),
      close: () => togglePanel(false),
      destroy: () => root.remove(),
    };
  }

  function addStylesOnce() {
    if (document.getElementById("chatkb-widget-styles")) return;
    const styles = document.createElement("style");
    styles.id = "chatkb-widget-styles";
    styles.textContent = `
.chatkb-widget {
  --chatkb-primary: #2563eb;
  position: fixed;
  bottom: 20px;
  z-index: 2147483000;
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.chatkb-widget[data-chatkb-position="right"] { right: 20px; }
.chatkb-widget[data-chatkb-position="left"] { left: 20px; }
.chatkb-bubble {
  border: 0;
  border-radius: 999px;
  background: var(--chatkb-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  padding: 12px 16px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.chatkb-panel {
  width: min(360px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 96px));
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin-bottom: 10px;
}
.chatkb-header {
  background: var(--chatkb-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
}
.chatkb-title { font-size: 14px; }
.chatkb-close {
  border: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  padding: 6px 8px;
  cursor: pointer;
}
.chatkb-error {
  background: #fef2f2;
  color: #991b1b;
  border-top: 1px solid #fecaca;
  border-bottom: 1px solid #fecaca;
  padding: 8px 12px;
  font-size: 13px;
}
.chatkb-messages {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #f9fafb;
}
.chatkb-message {
  max-width: 90%;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.35;
}
.chatkb-message p { margin: 0; white-space: pre-wrap; }
.chatkb-user {
  align-self: flex-end;
  color: #fff;
  background: var(--chatkb-primary);
}
.chatkb-assistant {
  align-self: flex-start;
  color: #0f172a;
  background: #fff;
  border: 1px solid #e5e7eb;
}
.chatkb-citations {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.chatkb-chip {
  border: 1px solid #cbd5e1;
  color: #334155;
  border-radius: 999px;
  font-size: 11px;
  padding: 3px 7px;
  background: #f8fafc;
}
.chatkb-form {
  border-top: 1px solid #e5e7eb;
  padding: 10px;
  display: flex;
  gap: 8px;
  background: #fff;
}
.chatkb-input {
  flex: 1;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 9px 10px;
  font-size: 14px;
}
.chatkb-send {
  border: 0;
  border-radius: 10px;
  background: var(--chatkb-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  padding: 0 13px;
  cursor: pointer;
}
.chatkb-send:disabled { opacity: 0.6; cursor: not-allowed; }
`;
    document.head.append(styles);
  }

  function bootstrap() {
    const script =
      document.currentScript ||
      document.querySelector("script[data-chatkb-project-handle],script[data-project-handle]");
    if (!script) {
      return;
    }

    const scriptOptions = window.ChatKBWidgetOptions || {};
    const projectHandle = coalesce(
      scriptOptions.projectHandle,
      script.getAttribute("data-chatkb-project-handle"),
      script.getAttribute("data-project-handle"),
    );

    const apiBase = coalesce(
      scriptOptions.apiBase,
      script.getAttribute("data-chatkb-api-base"),
      script.getAttribute("data-api-base"),
      inferApiBase(script),
    );

    if (!projectHandle) {
      console.error("ChatKB widget requires data-project-handle.");
      return;
    }
    if (!apiBase) {
      console.error("ChatKB widget requires a valid API base URL.");
      return;
    }

    const options = {
      ...DEFAULTS,
      ...scriptOptions,
      projectHandle,
      apiBase,
      position: coalesce(
        scriptOptions.position,
        script.getAttribute("data-chatkb-position"),
        script.getAttribute("data-position"),
        DEFAULTS.position,
      ),
      primaryColor: coalesce(
        scriptOptions.primaryColor,
        script.getAttribute("data-chatkb-primary-color"),
        script.getAttribute("data-primary-color"),
        DEFAULTS.primaryColor,
      ),
      welcomeText: coalesce(
        scriptOptions.welcomeText,
        script.getAttribute("data-chatkb-welcome-text"),
        script.getAttribute("data-welcome-text"),
        DEFAULTS.welcomeText,
      ),
      title: coalesce(
        scriptOptions.title,
        script.getAttribute("data-chatkb-title"),
        script.getAttribute("data-title"),
        DEFAULTS.title,
      ),
      launcherLabel: coalesce(
        scriptOptions.launcherLabel,
        script.getAttribute("data-chatkb-launcher-label"),
        script.getAttribute("data-launcher-label"),
        DEFAULTS.launcherLabel,
      ),
      placeholder: coalesce(
        scriptOptions.placeholder,
        script.getAttribute("data-chatkb-placeholder"),
        script.getAttribute("data-placeholder"),
        DEFAULTS.placeholder,
      ),
    };

    addStylesOnce();
    const instance = createWidget(options);
    window.ChatKBWidget = {
      version: VERSION,
      instance,
      open: () => instance?.open?.(),
      close: () => instance?.close?.(),
      destroy: () => instance?.destroy?.(),
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
