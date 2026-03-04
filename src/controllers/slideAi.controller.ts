import { Request, Response, NextFunction } from 'express';
// import { GoogleGenerativeAI, Schema, SchemaType } from '@google/generative-ai';
// import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

// ===========================================================================
// NEW: AI Orchestrator — Groq (primary) → Cohere (fallback)
// ===========================================================================
import { generateSlideContent } from '../services/ai/aiOrchestrator';

// ===========================================================================
// OPTION A: OpenRouter Implementation (Commented out per user request)
// ===========================================================================
/*
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY || '',
});
*/

// ===========================================================================
// OPTION B: Native Google Gemini Implementation (Commented out — replaced by orchestrator)
// Free tier gives 15 Requests Per Minute (RPM) and 1 Million Tokens / min
// ===========================================================================
/*
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const SYSTEM_PROMPT = `...`; // Moved to src/services/ai/systemPrompt.ts

const presentationSchema: Schema = { ... }; // Moved to src/services/ai/systemPrompt.ts
*/

// ---------------------------------------------------------------------------
// Controller: POST /api/slides/ai/generate
// ---------------------------------------------------------------------------
export const generateSlides = async (req: Request, res: Response, next: NextFunction) => {
  try {
    console.log('sending req to ai')
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ message: 'A prompt is required.' });
    }

    /* 
    // ======= OPENROUTER GENERATION LOGIC (Commented out) =======
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ message: 'OPENROUTER_API_KEY is not configured on the server.' });
    }

    const selectedModel = model || 'meta-llama/llama-3.3-70b-instruct:free';
    console.log(`🤖 AI Slide Generation — Model: ${selectedModel}, Prompt: "${prompt.slice(0, 80)}..."`);

    const completion = await openrouter.chat.completions.create({
      model: selectedModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 16000,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices?.[0]?.message?.content;
    // ==============================================================
    */

    /*
    // ======= NATIVE GEMINI GENERATION LOGIC (Commented out) =======
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: 'GEMINI_API_KEY is not configured on the server. Get one free at Google AI Studio.' });
    }

    const selectedModel =  'gemini-flash-latest';
    console.log(`🤖 AI Slide Generation (Google AI Studio) — Model: ${selectedModel}, Prompt: "${prompt.slice(0, 80)}..."`);

    const geminiModel = genAI.getGenerativeModel({
      model: selectedModel,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: presentationSchema,
      }
    });

    const result = await geminiModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: SYSTEM_PROMPT
    });

    const raw = result.response.text();
    // ==============================================================
    */

    // ======= NEW: ORCHESTRATOR (Groq → Cohere fallback) =======
    const { raw, provider } = await generateSlideContent(prompt);
    // ===========================================================

    if (!raw) {
      return res.status(502).json({ message: 'AI returned an empty response.' });
    }

    // Parse and validate the JSON
    let slideData;
    try {
      slideData = JSON.parse(raw);
    } catch (parseErr) {
      console.error('❌ AI returned invalid JSON:', raw.slice(0, 500));
      return res.status(502).json({ message: 'AI returned invalid JSON. Try again.' });
    }

    // Basic shape validation
    if (!slideData.slides || !Array.isArray(slideData.slides) || !slideData.blocks || !Array.isArray(slideData.blocks)) {
      return res.status(502).json({ message: 'AI response is missing slides or blocks arrays.' });
    }

    console.log(`✅ AI generated ${slideData.slides.length} slides with ${slideData.blocks.length} blocks via ${provider}!`);

    return res.status(200).json({
      success: true,
      data: slideData,
      model: provider,
      slideCount: slideData.slides.length,
      blockCount: slideData.blocks.length,
    });
  } catch (err: any) {
    console.error('❌ AI Generation Error:', err.message);

    // Handle rate-limit errors bubbled up from orchestrator
    if (err.status === 429 || (err.message && err.message.includes('rate limit'))) {
      return res.status(429).json({ message: 'Rate limited. Please wait a moment and try again.' });
    }
    if (err.status === 401) {
      return res.status(401).json({ message: 'Invalid API key.' });
    }

    // Handle "all providers failed" from orchestrator
    if (err.message && err.message.includes('All AI providers failed')) {
      return res.status(503).json({ message: 'All AI providers are currently unavailable. Please try again later.' });
    }

    next(err);
  }
};
