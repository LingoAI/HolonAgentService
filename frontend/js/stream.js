// POST + SSE transport. Exactly one terminal result: done, error, or aborted.
// Provider errors are control events, never answer tokens.
export async function streamChat(message, { onToken, onFact, onRoute, onPaths, onDone, onError, signal, url } = {}) {
  let reader, terminal = null;
  const finish = (status, error) => {
    if (terminal) return terminal;
    terminal = { status, ...(error ? { error } : {}) };
    if (status === "done") onDone?.();
    if (status === "error") onError?.(error);
    return terminal;
  };
  try {
    const res = await fetch(url || "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ message }), signal,
    });
    if (!res.ok) return finish("error", `HTTP ${res.status}`);
    if (!res.body || !/^text\/event-stream\b/i.test(res.headers.get("content-type") || "")) {
      return finish("error", "The server did not return a chat stream. Please try again.");
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "", event = "", data = [];
    const line = text => {
      if (!text) {
        if (event && data.length) {
          const handlers = { token: onToken, fact: onFact, route: onRoute, paths: onPaths };
          if (["token", "fact", "route", "paths", "done", "error"].includes(event)) {
            const value = JSON.parse(data.join("\n"));
            if (event === "done") finish("done");
            else if (event === "error") finish("error", typeof value === "string" ? value : value?.message || "The reply could not be completed.");
            else {
              if (event === "token" && typeof value !== "string") throw new Error("Invalid answer token");
              handlers[event]?.(value);
            }
          }
        }
        event = ""; data = [];
        return;
      }
      if (text.startsWith(":")) return; // heartbeat/comment
      const colon = text.indexOf(":"), field = colon < 0 ? text : text.slice(0, colon);
      let value = colon < 0 ? "" : text.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    };
    while (!terminal) {
      if (signal?.aborted) return finish("aborted");
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      // Accept LF, CRLF and CR, including a CRLF split across network chunks.
      while (!terminal) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (buffer[index] === "\r" && index === buffer.length - 1 && !chunk.done)) break;
        const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        const text = buffer.slice(0, index);
        buffer = buffer.slice(index + width);
        line(text);
      }
      if (buffer.length + data.reduce((n, part) => n + part.length, 0) > 1024 * 1024) {
        throw new Error("Chat event exceeded its size limit");
      }
      if (chunk.done) break;
    }
    return terminal || finish("error", "The connection ended before the reply finished. Please retry.");
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError") return finish("aborted");
    return finish("error", error instanceof SyntaxError || error instanceof TypeError
      ? "The reply stream could not be read. Please retry."
      : "The connection was interrupted. Please retry.");
  } finally {
    // Stop consuming after a terminal event; a later done cannot undo an error.
    if (reader) { try { await reader.cancel(); } catch { /* already closed */ } reader.releaseLock(); }
  }
}
