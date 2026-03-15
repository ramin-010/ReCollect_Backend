import { Request, Response, NextFunction } from 'express';
import { generateAIContent } from '../services/ai/aiOrchestrator';
import { DOCS_SYSTEM_PROMPT } from '../services/ai/docSystemPrompt';

// ---------------------------------------------------------------------------
// Post-processing: fix common TipTap JSON issues from AI output
// ---------------------------------------------------------------------------
function sanitizeTipTapContent(content: any[]): any[] {
  if (!Array.isArray(content)) return [];

  return content.map(node => {
    // Ensure every node has a type
    if (!node || !node.type) return null;

    // horizontalRule nodes must NOT have a content property
    if (node.type === 'horizontalRule') {
      return { type: 'horizontalRule' };
    }

    // listItem and taskItem must have at least one paragraph child
    if (node.type === 'listItem' || node.type === 'taskItem') {
      if (!node.content || !Array.isArray(node.content) || node.content.length === 0) {
        node.content = [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }];
      }
    }

    // codeBlock text must not have marks
    if (node.type === 'codeBlock' && node.content) {
      node.content = node.content.map((child: any) => {
        if (child.type === 'text') {
          const { marks, ...rest } = child;
          return rest;
        }
        return child;
      });
    }

    // Ensure content arrays on container nodes are valid
    if (node.content && Array.isArray(node.content)) {
      node.content = sanitizeTipTapContent(node.content);
    }

    // Ensure resizableImage has required attrs
    if (node.type === 'resizableImage') {
      if (!node.attrs) node.attrs = {};
      if (!node.attrs.src) return null; // Remove images without a source
      if (!node.attrs.alt) node.attrs.alt = 'AI generated image';
      if (!node.attrs.width) node.attrs.width = '100%';
    }

    return node;
  }).filter(Boolean); // Remove any nulls
}

// ---------------------------------------------------------------------------
// Strip image nodes from content (when user didn't ask for images)
// ---------------------------------------------------------------------------
function stripImageNodes(content: any[]): any[] {
  return content
    .filter(node => node.type !== 'resizableImage' && node.type !== 'image')
    .map(node => {
      if (node.content && Array.isArray(node.content)) {
        node.content = stripImageNodes(node.content);
      }
      return node;
    });
}

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
      // Strip markdown fences if present
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      docData = JSON.parse(cleaned);
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

    // Post-process: fix common TipTap JSON issues
    docData.content = sanitizeTipTapContent(docData.content);

    // Strip images if the user didn't ask for them (server-side safeguard)
    const imageKeywords = ['image', 'images', 'picture', 'pictures', 'photo', 'photos', 'illustration', 'illustrations', 'cover image'];
    const promptLower = prompt.trim().toLowerCase();
    const userWantsImages = imageKeywords.some(kw => promptLower.includes(kw));
    if (!userWantsImages) {
      docData.content = stripImageNodes(docData.content);
    }

    if (docData.content.length === 0) {
      return res.status(502).json({ message: 'AI returned empty content. Please try again.' });
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
