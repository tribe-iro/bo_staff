import type { Attachment } from "../types.ts";

export interface PromptSection {
  label: string;
  content: string;
}

export interface PromptEnvelope {
  system: {
    sections: PromptSection[];
  };
  user: {
    sections: PromptSection[];
    attachments: Attachment[];
  };
}
