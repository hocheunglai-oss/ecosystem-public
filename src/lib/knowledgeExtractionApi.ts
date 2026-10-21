import { assertLiveDataWritable } from './testWorkspaceGuard';
import { parseExtractionResponse } from "./knowledgeExtraction";
import type { LocationRecord } from "./locations";
import { assertPreviewWritable } from './previewGuard';

// The existing FC UNO/SPC server owns authentication and the OpenAI key.
export const knowledgeExtractionEndpoint =
  "https://spc.fcuno.com/api/ecosystem/knowledge-extract";
export const knowledgeSignInUrl = "https://spc.fcuno.com";

export class KnowledgeExtractionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function extractKnowledge(
  input: {
    text: string;
    source: string;
    sourceDate: string;
    contextKey: string;
    locations: LocationRecord[];
  },
  signal: AbortSignal,
) {
  assertPreviewWritable();
  assertLiveDataWritable();
  const response = await fetch(knowledgeExtractionEndpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      text: input.text,
      source: input.source,
      sourceDate: input.sourceDate || null,
      contextKey: input.contextKey || null,
      locations: input.locations.map(({ key, name, kind, country, path }) => ({
        key,
        name,
        kind,
        country,
        path,
      })),
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      response.status === 401
        ? "Sign in to FC UNO or SPC, then retry extraction."
        : typeof body?.error === "string"
          ? body.error.slice(0, 350)
          : "Extraction is unavailable. Please try again.";
    throw new KnowledgeExtractionError(message, response.status);
  }
  return parseExtractionResponse(body);
}
