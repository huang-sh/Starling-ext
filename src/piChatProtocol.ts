import { StringDecoder } from "string_decoder";

export type PiChatRole = "user" | "assistant" | "tool";

export interface PiChatMessage {
  role: PiChatRole;
  text: string;
  thinking?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Pi RPC uses strict LF framing. In particular, U+2028/U+2029 are valid JSON
 * string contents and must never be treated as line endings.
 */
export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.takeCompleteLines();
  }

  end(): string[] {
    this.buffer += this.decoder.end();
    const lines = this.takeCompleteLines();
    if (this.buffer.length > 0) {
      lines.push(stripOptionalCarriageReturn(this.buffer));
      this.buffer = "";
    }
    return lines;
  }

  private takeCompleteLines(): string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return lines;
      lines.push(stripOptionalCarriageReturn(this.buffer.slice(0, newline)));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }
}

function stripOptionalCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function normalizePiMessages(value: unknown): PiChatMessage[] {
  if (!Array.isArray(value)) return [];
  const normalized: PiChatMessage[] = [];

  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.role !== "string") continue;

    if (raw.role === "user") {
      const text = contentText(raw.content);
      if (text) normalized.push({ role: "user", text });
      continue;
    }

    if (raw.role === "assistant") {
      const blocks = Array.isArray(raw.content) ? raw.content : [];
      const text = blocks
        .filter((block) => isRecord(block) && block.type === "text")
        .map((block) => String((block as Record<string, unknown>).text ?? ""))
        .join("");
      const thinking = blocks
        .filter((block) => isRecord(block) && block.type === "thinking")
        .map((block) => String((block as Record<string, unknown>).thinking ?? (block as Record<string, unknown>).text ?? ""))
        .join("");
      if (text || thinking) {
        normalized.push({ role: "assistant", text, thinking: thinking || undefined });
      }
      for (const block of blocks) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        normalized.push({
          role: "tool",
          toolName: String(block.name ?? "tool"),
          text: printable(block.arguments ?? block.args ?? ""),
        });
      }
      continue;
    }

    if (raw.role === "toolResult") {
      normalized.push({
        role: "tool",
        toolName: typeof raw.toolName === "string" ? raw.toolName : "tool result",
        text: contentText(raw.content) || printable(raw.content),
        isError: raw.isError === true,
      });
    }
  }

  return normalized;
}

export function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => String((block as Record<string, unknown>).text ?? ""))
    .join("");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
