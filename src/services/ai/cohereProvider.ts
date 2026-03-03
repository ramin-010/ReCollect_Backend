// ===========================================================================
// Cohere AI Provider — Fallback provider for slide generation
// Free trial: 1,000 calls/month, 20 RPM on Chat endpoint
// ===========================================================================

import { CohereClient } from 'cohere-ai';
import { SYSTEM_PROMPT, PRESENTATION_JSON_SCHEMA } from './systemPrompt';
import dotenv from 'dotenv';
dotenv.config();

const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY || '',
});

// Default model — Command A (March 2025, free on trial keys)
const DEFAULT_MODEL = 'command-a-03-2025';

/**
 * Generate slide content using Cohere's API.
 * @param prompt - The user's slide generation prompt
 * @returns Raw JSON string of the generated presentation
 * @throws Error on rate limit, auth failure, or other API errors
 */
export async function generateWithCohere(prompt: string): Promise<string> {
  const model = DEFAULT_MODEL;
  console.log(`🤖 AI Slide Generation (Cohere) — Model: ${model}, Prompt: "${prompt.slice(0, 80)}..."`);

  const response = await cohere.chat({
    model,
    message: `${SYSTEM_PROMPT}\n\n---\n\nUser request: ${prompt}\n\nRespond ONLY with valid JSON matching the schema. No extra text.`,
    temperature: 0.7,
    maxTokens: 8192,
    responseFormat: {
      type: 'json_object',
      schema: PRESENTATION_JSON_SCHEMA,
    },
  });

  const raw = response.text;

  if (!raw) {
    throw new Error('Cohere returned an empty response.');
  }

  return raw;
}
