import { Request, Response, NextFunction } from 'express';
import { generateAIContent } from '../services/ai/aiOrchestrator';
import { TASK_AI_SYSTEM_PROMPT } from '../services/ai/taskAiSystemPrompt';

// ---------------------------------------------------------------------------
// Controller: POST /api/todos/ai/generate
// ---------------------------------------------------------------------------
export const generateTaskContent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prompt, workspaceMembers = [], availableTags = [], preSelectedAssignees = [] } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ message: 'A prompt is required.' });
    }

    // Build context to inject into the prompt
    const today = new Date().toISOString().split('T')[0];
    const membersContext = workspaceMembers.length > 0
      ? `WORKSPACE_MEMBERS:\n${workspaceMembers.map((m: any) => `- ${m.name} (${m.email})`).join('\n')}`
      : 'WORKSPACE_MEMBERS: none (personal task, no assignees available)';

    const tagsContext = availableTags.length > 0
      ? `AVAILABLE_TAGS: ${availableTags.join(', ')}`
      : '';

    const assigneeContext = preSelectedAssignees.length > 0
      ? `PRE-SELECTED ASSIGNEES (user explicitly @-mentioned these people):\n${preSelectedAssignees.map((a: any) => `- ${a.name} (${a.email})`).join('\n')}`
      : '';

    const fullPrompt = `TODAY'S DATE: ${today}\n${membersContext}\n${tagsContext}\n${assigneeContext}\n\nUser request: ${prompt.trim()}`;

    console.log(`🤖 Task AI Generation — Prompt: "${prompt.trim().slice(0, 120)}..."`);

    const { raw, provider } = await generateAIContent(fullPrompt, TASK_AI_SYSTEM_PROMPT);

    if (!raw) {
      return res.status(502).json({ message: 'AI returned an empty response.' });
    }

    // Parse JSON response
    let taskData;
    try {
      // Strip markdown code fences if AI wraps them
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      taskData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('❌ Task AI returned invalid JSON:', raw.slice(0, 500));
      return res.status(502).json({ message: 'AI returned invalid JSON. Try again.' });
    }

    // Validate required fields
    if (!taskData.title || typeof taskData.title !== 'string') {
      taskData.title = prompt.trim().slice(0, 80);
    }

    // Normalize priority
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (!validPriorities.includes(taskData.priority)) {
      taskData.priority = 'normal';
    }

    // Ensure arrays
    if (!Array.isArray(taskData.tags)) taskData.tags = [];
    if (!Array.isArray(taskData.assignees)) taskData.assignees = [];

    // Validate assignee emails against workspace members
    if (workspaceMembers.length > 0) {
      const validEmails = new Set(workspaceMembers.map((m: any) => m.email.toLowerCase()));
      taskData.assignees = taskData.assignees.filter((email: string) =>
        validEmails.has(email.toLowerCase())
      );
    } else {
      taskData.assignees = [];
    }

    console.log(`✅ Task AI generated via ${provider}: "${taskData.title}"`);

    return res.status(200).json({
      success: true,
      data: taskData,
      provider,
    });
  } catch (err: any) {
    console.error('❌ Task AI Generation Error:', err.message);

    if (err.status === 429 || (err.message && err.message.includes('rate limit'))) {
      return res.status(429).json({ message: 'Rate limited. Please wait a moment and try again.' });
    }
    if (err.message && err.message.includes('All AI providers failed')) {
      return res.status(503).json({ message: 'All AI providers are currently unavailable. Please try again later.' });
    }

    next(err);
  }
};
