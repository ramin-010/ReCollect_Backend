// ===========================================================================
// Groq AI Provider — Primary provider for AI generation
// Free tier: ~14,400 RPD, ~40k TPM for Llama models
// Uses OpenAI-compatible SDK
// ===========================================================================

import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '',
});

/**
 * Generate content using Groq's API.
 * @param prompt - The user's generation prompt
 * @param systemPrompt - The system prompt that defines output format and behavior
 * @param model - The specific Groq model to use
 * @param maxTokens - Maximum output tokens
 * @returns Raw string of the generated content
 */
export async function generateWithGroq(
  prompt: string,
  systemPrompt: string,
  model: string = 'llama-3.3-70b-versatile',
  maxTokens: number = 8192
): Promise<string> {
  console.log(`🤖 AI Generation (Groq) — Model: ${model}, Max Tokens: ${maxTokens}, Prompt: "${prompt.slice(0, 80)}..."`);

  const completion = await groq.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error('Groq returned an empty response.');
  }

  return raw;
}
