export async function readTextResponse(response: Response): Promise<string> {
  const text = await response.text();
  return text;
}

export async function parseSseStream(
  response: Response,
  onEvent: (payload: string) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Provider returned no stream body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event.split("\n").filter((line) => line.startsWith("data: "));
      for (const line of lines) {
        const payload = line.slice(6).trim();
        if (payload && payload !== "[DONE]") {
          onEvent(payload);
        }
      }
    }
  }
}

export async function parseNdjsonStream(
  response: Response,
  onLine: (payload: string) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Provider returned no stream body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const payload = line.trim();
      if (payload) {
        onLine(payload);
      }
    }
  }

  if (buffer.trim()) {
    onLine(buffer.trim());
  }
}

