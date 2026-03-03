// ===========================================================================
// Groq AI Provider — Primary provider for slide generation
// Free tier: ~14,400 RPD, ~40k TPM for Llama models
// Uses OpenAI-compatible SDK
// ===========================================================================

import Groq from 'groq-sdk';
import { SYSTEM_PROMPT } from './systemPrompt';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '',
});

// Default model — Llama 3.3 70B is free and has generous limits
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/**
 * Generate slide content using Groq's API.
 * @param prompt - The user's slide generation prompt
 * @param model - The specific Groq model to use (e.g. 'llama-3.3-70b-versatile' or 'gemma-3-27b-it')
 * @param maxTokens - Maximum output tokens for the generation
 * @returns Raw JSON string of the generated presentation
 * @throws Error on rate limit (429), auth failure, or other API errors
 */
export async function generateWithGroq(prompt: string, model: string = 'llama-3.3-70b-versatile', maxTokens: number = 8192): Promise<string> {
  console.log(`🤖 AI Slide Generation (Groq) — Model: ${model}, Max Tokens: ${maxTokens}, Prompt: "${prompt.slice(0, 80)}..."`);

  const completion = await groq.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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
