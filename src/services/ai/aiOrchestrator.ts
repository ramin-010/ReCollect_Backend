import { generateWithGroq } from './groqProvider';
import { generateWithGoogle } from './googleProvider';
import { generateWithCohere } from './cohereProvider';

export interface AIGenerationResult {
  raw: string;
  provider: string;
}

export async function generateSlideContent(prompt: string): Promise<AIGenerationResult> {
  // 1. Groq - Llama 3.3 70B (Smartest, 12K TPM, 1K RPD)
  try {
    const raw = await generateWithGroq(prompt, 'llama-3.3-70b-versatile', 16000);
    return { raw, provider: 'groq (llama-3.3-70b)' };
  } catch (err: any) {
    console.warn(`⚠️ Groq (Llama 70B) failed: ${err.message || err}`);
    console.log('⤵️ Falling back to Groq Llama 4 Scout...');
  }

  // 2. Groq - Llama 4 Scout 17B (Smart, Fast, 30K TPM, 1K RPD)
  try {
    const raw = await generateWithGroq(prompt, 'meta-llama/llama-4-scout-17b-16e-instruct', 8192);
    return { raw, provider: 'groq (llama-4-scout)' };
  } catch (err: any) {
    console.warn(`⚠️ Groq (Llama 4 Scout) failed: ${err.message || err}`);
    console.log('⤵️ Falling back to Groq Llama 3.1 8B...');
  }

  // 3. Groq - Llama 3.1 8B (Fastest, 6K TPM, massive 14.4K RPD allowance)
  try {
    const raw = await generateWithGroq(prompt, 'llama-3.1-8b-instant', 16000);
    return { raw, provider: 'groq (llama-3.1-8b)' };
  } catch (err: any) {
    console.warn(`⚠️ Groq (Llama 3.1 8B) failed: ${err.message || err}`);
    console.log('⤵️ Falling back to Google AI Studio (Gemini)...');
  }

  // 4. Google - Gemini 1.5 Flash (Smart, Native JSON mode)
  try {
    const raw = await generateWithGoogle(prompt, 'gemini-flash-latest');
    return { raw, provider: 'google (gemini)' };
  } catch (err: any) {
    console.warn(`⚠️ Google AI Studio (Gemini) failed: ${err.message || err}`);
    console.log('⤵️ Falling back to Cohere...');
  }

  // 5. Cohere - Command A (Smart fallback)
  try {
    const raw = await generateWithCohere(prompt);
    return { raw, provider: 'cohere' };
  } catch (err: any) {
    console.error(`❌ Cohere failed: ${err.message || err}`);
    console.log('⤵️ Falling back to Google AI Studio (Gemma)...');
  }

  // 6. Google - Gemma 3 27B (Final safety net, huge 14.4K RPD allowance)
  try {
    const raw = await generateWithGoogle(prompt, 'gemma-3-27b-it');
    return { raw, provider: 'google (gemma)' };
  } catch (err: any) {
    console.warn(`⚠️ Google AI Studio (Gemma) also failed: ${err.message || err}`);
  }

  throw new Error('All AI providers failed. Please try again later.');
}
