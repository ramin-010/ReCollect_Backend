// ===========================================================================
// Cohere AI Provider — Fallback provider for AI generation
// Free trial: 1,000 calls/month, 20 RPM on Chat endpoint
// ===========================================================================

import { CohereClient } from 'cohere-ai';
import dotenv from 'dotenv';
dotenv.config();

const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY || '',
});

const DEFAULT_MODEL = 'command-a-03-2025';

/**
 * Generate content using Cohere's API.
 * @param prompt - The user's generation prompt
 * @param systemPrompt - The system prompt that defines output format and behavior
 * @returns Raw string of the generated content
 */
export async function generateWithCohere(
  prompt: string,
  systemPrompt: string
): Promise<string> {
  const model = DEFAULT_MODEL;
  console.log(`🤖 AI Generation (Cohere) — Model: ${model}, Prompt: "${prompt.slice(0, 80)}..."`);

  const response = await cohere.chat({
    model,
    message: `${systemPrompt}\n\n---\n\nUser request: ${prompt}\n\nRespond ONLY with valid JSON matching the schema. No extra text.`,
    temperature: 0.7,
    maxTokens: 8192,
    responseFormat: {
      type: 'json_object',
    },
  });

  const raw = response.text;

  if (!raw) {
    throw new Error('Cohere returned an empty response.');
  }

  return raw;
}
