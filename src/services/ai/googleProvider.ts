// ===========================================================================
// Google AI Studio Provider — Secondary fallback for AI generation
// Free tier (Gemma 3): 14.4K RPD, 15K TPM
// Uses official @google/generative-ai SDK
// ===========================================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const DEFAULT_MODEL = 'gemma-3-27b-it';

/**
 * Generate content using Google AI Studio (Gemini/Gemma).
 * @param prompt - The user's generation prompt
 * @param systemPrompt - The system prompt that defines output format and behavior
 * @param model - The specific model to use
 * @returns Raw string of the generated content
 */
export async function generateWithGoogle(
  prompt: string,
  systemPrompt: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  console.log(`🤖 AI Generation (Google AI Studio) — Model: ${model}, Prompt: "${prompt.slice(0, 80)}..."`);

  const isGemma = model.toLowerCase().includes('gemma');

  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
      // Only Gemini supports the JSON mime type. Gemma throws an error if we include this.
      ...(isGemma ? {} : { responseMimeType: "application/json" }),
    },
    // Only Gemini supports native system instructions on this API.
    ...(isGemma ? {} : { systemInstruction: systemPrompt })
  });

  const parts = isGemma
    ? [{ text: `${systemPrompt}\n\n---\n\nUser request: ${prompt}\n\nRespond ONLY with valid JSON matching the schema. No extra text.` }]
    : [{ text: prompt }];

  const result = await generativeModel.generateContent({
      contents: [{ role: 'user', parts }]
  });

  let raw = result.response.text();

  if (!raw) {
    throw new Error('Google AI Studio returned an empty response.');
  }

  // Clean up markdown block wrapping if Gemma outputs ```json { ... } ```
  raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();

  return raw;
}
