// When mento runs outside Claude, this stands in for Claude's built-in generation and calls your server instead.
// Set MENTO_API to your Supabase function URL. Empty = generation off.
window.MENTO_API = window.MENTO_API || "";
window.makeServerSampler = function (endpoint) {
  const err = (code, message, text) => Object.assign({ code, message: message || code }, text ? { text } : {});
  async function toImg(blob) {
    try {
      const url = URL.createObjectURL(blob), img = new Image();
      await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; });
      const s = Math.min(1, 1568 / Math.max(img.width, img.height)), cv = document.createElement("canvas");
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      return { type: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.85).split(",")[1] };
    } catch (e) { throw err("image_rejected", "That image couldn't be read."); }
  }
  async function call(input, opts = {}, wantJson = false) {
    const prompt = typeof input === "string" ? input : (input || []).map(m => (m.role === "assistant" ? "Assistant: " : "") + m.content).join("\n\n");
    const images = opts.images ? await Promise.all(Array.from(opts.images).slice(0, 8).map(toImg)) : [];
    const stream = typeof opts.onText === "function";
    let r;
    try {
      r = await fetch(endpoint, { method: "POST", signal: opts.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, images, model: opts.modelTier === "quick" ? "quick" : "default", stream, json: wantJson }) });
    } catch (e) { throw err(opts.signal && opts.signal.aborted ? "cancelled" : "upstream_error"); }
    if (!r.ok) { let b = {}; try { b = await r.json(); } catch (e) {} throw err(b.error === "rate_limited" || r.status === 429 ? "rate_limited" : "upstream_error", b.detail); }
    if (!stream) { const b = await r.json(); if (!b.text || !b.text.trim()) throw err("empty_completion"); return { text: b.text, truncated: !!b.truncated }; }
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "", text = "", truncated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n"); buf = events.pop();
        for (const ev of events) {
          const line = ev.split("\n").find(l => l.startsWith("data:")); if (!line) continue;
          let d; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (d.type === "content_block_delta" && d.delta && d.delta.text) { text += d.delta.text; opts.onText({ text, delta: d.delta.text }); }
          if (d.type === "message_delta" && d.delta && d.delta.stop_reason === "max_tokens") truncated = true;
          if (d.type === "error") throw err("upstream_error", d.error && d.error.message, text);
        }
      }
    } catch (e) { if (opts.signal && opts.signal.aborted) throw err("cancelled", "", text); throw e.code ? e : err("upstream_error", "", text); }
    if (!text.trim()) throw err("empty_completion");
    return { text, truncated };
  }
  function parseJSON(t) {
    const s = t.trim();
    try { return JSON.parse(s); } catch (e) {}
    const f = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
    const a = Math.min(...["{", "["].map(c => { const i = s.indexOf(c); return i < 0 ? Infinity : i; })), b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (a < Infinity && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
    throw err("invalid_json", "", t);
  }
  const sampler = (input, opts) => call(input, opts, false);
  sampler.json = async (input, opts = {}) => { const { text, truncated } = await call(input, opts, true); if (truncated) throw err("invalid_json", "cut short", text); return parseJSON(text); };
  sampler.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 8, maxInputBytes: 20000000, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } });
  return sampler;
};
