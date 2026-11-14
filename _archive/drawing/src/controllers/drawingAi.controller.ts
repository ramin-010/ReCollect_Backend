import { Request, Response, NextFunction } from 'express';
import { generateAIContent } from '../services/ai/aiOrchestrator';
import { DRAWING_AI_SYSTEM_PROMPT } from '../services/ai/drawingAiSystemPrompt';

// ---------------------------------------------------------------------------
// Sanitize common Mermaid syntax mistakes that LLMs produce
// ---------------------------------------------------------------------------
function sanitizeMermaid(syntax: string): string {
  let result = syntax;

  // Fix: -->|"quoted label"|> B  →  -->|quoted label| B
  // The extra > after the closing pipe is invalid
  result = result.replace(/\|>\s+/g, '| ');

  // Fix: -->|"quoted label"| B  →  -->|quoted label| B
  // Quoted labels inside pipes are invalid in flowcharts
  result = result.replace(/\|"([^"]+)"\|/g, '|$1|');

  // Fix: subgraph "Title"  →  subgraph Title
  result = result.replace(/subgraph\s+"([^"]+)"/g, 'subgraph $1');

  // Fix: Double-headed arrows like <--> which some LLMs generate
  result = result.replace(/<-->/g, '<-->');

  // Remove any stray ``` markdown fences that slipped in
  result = result.replace(/```[a-z]*/gi, '').replace(/```/g, '');

  return result.trim();
}

// ---------------------------------------------------------------------------
// Controller: POST /api/drawings/ai/generate
// Takes a natural language prompt and returns valid Mermaid.js syntax
// that the frontend converts to native Excalidraw elements.
// ---------------------------------------------------------------------------
export const generateDrawingContent = async (req: Request, res: Response, next: NextFunction) => {
  // TEMPORARILY DISABLED: Feature is "Coming Soon"
  return res.status(501).json({ 
    success: false, 
    message: 'AI drawing generation is coming soon!' 
  });
};
