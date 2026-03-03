// ===========================================================================
// Email AI Service — Standalone AI email drafting
// Has its OWN system prompt — completely separate from the slide AI pipeline
// Uses the same API keys but different prompts and configurations
// ===========================================================================

import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CohereClient } from 'cohere-ai';
import dotenv from 'dotenv';
dotenv.config();

interface EmailDraftParams {
    recipient: string;
    recipientName?: string | undefined;
    subject?: string | undefined;
    context: string;
    tone: 'professional' | 'casual' | 'friendly' | 'formal' | 'persuasive';
    instructions?: string | undefined;
    threadHistory?: string | undefined;
}

interface EmailDraftResult {
    subject: string;
    body: string;
    provider: string;
}

// ─── Email-Specific System Prompt ────────────────────────────────────────────
const EMAIL_SYSTEM_PROMPT = `You are a professional email writing assistant. Your job is to draft well-written, contextually appropriate emails.

RULES:
- Write naturally, like a real person — avoid corporate jargon and filler
- Match the requested tone precisely (professional, casual, friendly, formal, persuasive)
- Keep emails concise and well-structured
- Use proper email etiquette (greeting, body, sign-off)
- For replies, continue the conversation naturally using the provided thread context
- Use clean HTML for formatting: <p> tags for paragraphs, <br> for line breaks
- Do NOT include <html>, <head>, or <body> wrapper tags — just inner content
- Always respond with ONLY valid JSON, no markdown wrapping, no extra text

RESPONSE FORMAT (strict JSON):
{
  "subject": "The email subject line",
  "body": "The email body in clean HTML"
}`;

// ─── Build the User Prompt ──────────────────────────────────────────────────
function buildEmailPrompt(params: EmailDraftParams): string {
    const { recipient, recipientName, subject, context, tone, instructions, threadHistory } = params;

    let prompt = `Draft an email with the following details:

RECIPIENT: ${recipientName ? `${recipientName} (${recipient})` : recipient}
${subject ? `SUBJECT: ${subject}` : 'Generate an appropriate subject line.'}
CONTEXT/PURPOSE: ${context}
TONE: ${tone}
${instructions ? `ADDITIONAL INSTRUCTIONS: ${instructions}` : ''}
${threadHistory ? `\nPREVIOUS THREAD (this is a reply — continue the conversation naturally):\n${threadHistory}` : ''}

Respond with JSON only: { "subject": "...", "body": "..." }`;

    return prompt;
}

// ─── Provider 1: Groq (Llama) ───────────────────────────────────────────────
async function emailWithGroq(prompt: string, model: string = 'llama-3.3-70b-versatile'): Promise<string> {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

    console.log(`📧 Email AI (Groq) — Model: ${model}`);

    const completion = await groq.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: EMAIL_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
    });

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Groq returned empty response for email draft.');
    return raw;
}

// ─── Provider 2: Google Gemini ──────────────────────────────────────────────
async function emailWithGoogle(prompt: string): Promise<string> {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

    console.log(`📧 Email AI (Google Gemini)`);

    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
        },
        systemInstruction: EMAIL_SYSTEM_PROMPT,
    });

    const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    let raw = result.response.text();
    if (!raw) throw new Error('Gemini returned empty response for email draft.');

    // Clean markdown wrapping if present
    raw = raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
    return raw;
}

// ─── Provider 3: Cohere ─────────────────────────────────────────────────────
async function emailWithCohere(prompt: string): Promise<string> {
    const cohere = new CohereClient({ token: process.env.COHERE_API_KEY || '' });

    console.log(`📧 Email AI (Cohere)`);

    const response = await cohere.chat({
        model: 'command-a-03-2025',
        message: `${EMAIL_SYSTEM_PROMPT}\n\n---\n\n${prompt}\n\nRespond ONLY with valid JSON. No extra text.`,
        temperature: 0.7,
        maxTokens: 4096,
    });

    const raw = response.text;
    if (!raw) throw new Error('Cohere returned empty response for email draft.');
    return raw;
}

// ─── Main: Generate Email Draft (with fallback chain) ───────────────────────
/**
 * Generate an AI email draft using the provider fallback chain:
 * Groq (Llama 3.3 70B) → Groq (Llama 4 Scout) → Google Gemini → Cohere
 */
export async function generateEmailDraft(params: EmailDraftParams): Promise<EmailDraftResult> {
    const prompt = buildEmailPrompt(params);

    // 1. Groq — Llama 3.3 70B
    try {
        const raw = await emailWithGroq(prompt, 'llama-3.3-70b-versatile');
        return { ...parseEmailResponse(raw), provider: 'groq (llama-3.3-70b)' };
    } catch (err: any) {
        console.warn(`⚠️ Email AI — Groq (70B) failed: ${err.message}`);
    }

    // 2. Groq — Llama 4 Scout
    try {
        const raw = await emailWithGroq(prompt, 'meta-llama/llama-4-scout-17b-16e-instruct');
        return { ...parseEmailResponse(raw), provider: 'groq (llama-4-scout)' };
    } catch (err: any) {
        console.warn(`⚠️ Email AI — Groq (Scout) failed: ${err.message}`);
    }

    // 3. Google Gemini
    try {
        const raw = await emailWithGoogle(prompt);
        return { ...parseEmailResponse(raw), provider: 'google (gemini)' };
    } catch (err: any) {
        console.warn(`⚠️ Email AI — Gemini failed: ${err.message}`);
    }

    // 4. Cohere
    try {
        const raw = await emailWithCohere(prompt);
        return { ...parseEmailResponse(raw), provider: 'cohere' };
    } catch (err: any) {
        console.warn(`⚠️ Email AI — Cohere failed: ${err.message}`);
    }

    throw new Error('All AI providers failed for email drafting. Please try again later.');
}

// ─── Response Parser ─────────────────────────────────────────────────────────
function parseEmailResponse(raw: string): { subject: string; body: string } {
    try {
        let jsonStr = raw.trim();
        // Handle markdown code block wrapping
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1]!.trim();
        }

        const parsed = JSON.parse(jsonStr);

        if (!parsed.subject || !parsed.body) {
            throw new Error('Missing subject or body in AI response');
        }

        return { subject: parsed.subject, body: parsed.body };
    } catch (err) {
        throw new Error(`Failed to parse AI email response: ${err}`);
    }
}
