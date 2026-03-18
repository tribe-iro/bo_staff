import { readFile } from "node:fs/promises";
import { DEFAULT_ATTACHMENT_CHAR_LIMIT } from "../config/defaults.ts";
import type { Attachment } from "../types.ts";

export interface PromptAttachmentBlock {
  label: string;
  content: string;
}

export async function resolvePromptAttachments(attachments: Attachment[]): Promise<PromptAttachmentBlock[]> {
  return Promise.all(attachments.map(resolvePromptAttachment));
}

async function resolvePromptAttachment(attachment: Attachment): Promise<PromptAttachmentBlock> {
  if (attachment.kind === "inline") {
    return {
      label: `Attachment ${attachment.name} (${attachment.mime_type ?? "inline"})`,
      content: truncateAttachmentContent(attachment.content)
    };
  }
  if (attachment.kind === "path") {
    try {
      const content = await readFile(attachment.path, "utf8");
      return {
        label: `Attachment ${attachment.name} from ${attachment.path}`,
        content: truncateAttachmentContent(content)
      };
    } catch {
      return {
        label: `Attachment ${attachment.name} from ${attachment.path}`,
        content: "<unreadable>"
      };
    }
  }
  throw new Error(`Unsupported attachment kind: ${(attachment as { kind?: string }).kind ?? "unknown"}`);
}

function truncateAttachmentContent(content: string): string {
  return content.length > DEFAULT_ATTACHMENT_CHAR_LIMIT
    ? `${content.slice(0, DEFAULT_ATTACHMENT_CHAR_LIMIT)}\n[truncated]`
    : content;
}
