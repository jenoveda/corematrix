export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  limit = 1024 * 1024,
) {
  const reader = body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    size = 0,
    data: string[] = [],
    event = "message";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.value) {
        size += chunk.value.byteLength;
        if (size > limit) throw new Error("sse_size_limit");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      if (chunk.done) buffer += decoder.decode();
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0) break;
        if (buffer[end] === "\r" && end === buffer.length - 1 && !chunk.done)
          break;
        const line = buffer.slice(0, end),
          length = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + length);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          data = [];
          event = "message";
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":"),
          field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
