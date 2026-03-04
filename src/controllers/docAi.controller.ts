import { Request, Response, NextFunction } from 'express';
import { generateAIContent } from '../services/ai/aiOrchestrator';
import { DOCS_SYSTEM_PROMPT } from '../services/ai/docSystemPrompt';

// ---------------------------------------------------------------------------
// Controller: POST /api/docs/ai/generate
// ---------------------------------------------------------------------------
export const generateDocContent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prompt, context } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ message: 'A prompt is required.' });
    }

    // Build the full prompt, optionally including surrounding editor context
    let fullPrompt = prompt.trim();
    if (context && typeof context === 'string' && context.trim().length > 0) {
      fullPrompt = `Context (text surrounding the cursor in the user's document):\n"""${context.trim()}"""\n\nUser request: ${fullPrompt}`;
    }

    console.log(`📝 Doc AI Generation — Prompt: "${fullPrompt.slice(0, 100)}..."`);

    const { raw, provider } = await generateAIContent(fullPrompt, DOCS_SYSTEM_PROMPT);

    if (!raw) {
      return res.status(502).json({ message: 'AI returned an empty response.' });
    }

    // Parse and validate the JSON
    let docData;
    try {
      docData = JSON.parse(raw);
    } catch (parseErr) {
      console.error('❌ AI returned invalid JSON:', raw.slice(0, 500));
      return res.status(502).json({ message: 'AI returned invalid JSON. Try again.' });
    }

    // Validate shape — must have a content array
    if (!docData.content || !Array.isArray(docData.content)) {
      // If the AI returned a doc wrapper, unwrap it
      if (docData.type === 'doc' && docData.content) {
        // Already good — keep as-is but just return the inner content
      } else {
        return res.status(502).json({ message: 'AI response is missing content array.' });
      }
    }

    console.log(`✅ Doc AI generated ${docData.content.length} nodes via ${provider}`);

    return res.status(200).json({
      success: true,
      data: docData,
      provider,
      nodeCount: docData.content.length,
    });
  } catch (err: any) {
    console.error('❌ Doc AI Generation Error:', err.message);

    if (err.status === 429 || (err.message && err.message.includes('rate limit'))) {
      return res.status(429).json({ message: 'Rate limited. Please wait a moment and try again.' });
    }
    if (err.status === 401) {
      return res.status(401).json({ message: 'Invalid API key.' });
    }
    if (err.message && err.message.includes('All AI providers failed')) {
      return res.status(503).json({ message: 'All AI providers are currently unavailable. Please try again later.' });
    }

    next(err);
  }
};
