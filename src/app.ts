// Builds the Express app: middleware, routes and the error handler, in the same order as before.
// It does NOT connect to MongoDB, start crons, listen or start Hocuspocus; src/index.ts does that.
// Tests import this file directly (supertest).
//
// Order matters: userRoutes is mounted on '/api' with router.use(authMiddleware), so every
// '/api/*' request that reaches it (all routers mounted after it) goes through auth first.
import 'dotenv/config';
import express, { Application } from 'express'
import morgan from 'morgan';
import cors from 'cors'
import cookieParser from 'cookie-parser';

import errorHandler from './middlwares/errorHandler';

import workspaceRoutes, { publicWorkspaceRouter } from './routers/workspace.routes';
import authRouter from './routers/auth.routes'
import publicRouter from './routers/public.routes';
import tagQueryRouter from './routers/tagQuery.routes'
import otpRoutes from './routers/otp.routes'
import todoRoutes from './routers/todo.routes';
import workspaceTodoRoutes from './routers/workspaceTodo.routes';
import userRoutes from './routers/user.routes'
import docRoutes from './routers/doc.routes';
import docAiRoutes from './routers/docAi.routes';
import taskAiRoutes from './routers/taskAi.routes';
import uploadRoutes from './routers/upload.routes';
import notificationRoutes from './routers/notification.routes';
import recentVisitRoutes from './routers/recentVisit.routes';
import learningRoutes from './routers/learning.routes';
import agentRoutes from './routers/agent.routes';
import apiTokenRoutes from './routers/apiToken.routes';
import canvasRoutes from './routers/canvas.routes';
import recallRoutes, { aiRouter } from './routers/recall.routes';
import assistantRoutes from './routers/assistant.routes';
import alwaysOnRoutes from './routers/alwaysOn.routes';
import mcpRoutes from './routers/mcp.routes';
import phoneRoutes from './routers/phone.routes';
import buddyRoutes from './routers/buddy.routes';
import { consentRouter, publicOAuthRouter } from './routers/oauth.routes';
import { healthDbRouter, healthzRouter } from './routers/health.routes';
import { allowedOrigins } from './config/origins';

// Cut on the pg-migration branch (files in backend/_archive): content, dashboards (dash),
// expenses, slides + slide AI, livekit, email (Gmail). Whiteboard (drawings + drawing AI): backend/_archive/drawing.


export function createApp(): Application {
    const app: Application = express();

    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    if (process.env.NODE_ENV === 'production') {
        // Hosting P1-7: method, path without its query, status, milliseconds. No query, body or name.
        app.use(morgan((tokens, req, res) => `${tokens.method?.(req, res)} ${(req.originalUrl || req.url || '').split('?')[0]} ${tokens.status?.(req, res)} ${tokens['response-time']?.(req, res)} ms`));
    } else if (process.env.NODE_ENV !== 'test') {
        app.use(morgan('dev'));
    }
    app.use(cookieParser())
    //  disable caching for the API
    app.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store'); // Tells Cloudflare explicitly not to cache
        next();
    });

    // GET /healthz: "the process is up", for an outside checker. No database, no login, no CORS.
    app.use(healthzRouter);

    // Sign-in for MCP clients: other apps' servers call these, so they sit before the CORS check.
    app.use(publicOAuthRouter);

    app.use(cors({
        origin: (origin, cb) => {
            if (!origin || allowedOrigins().includes(origin)) {
                cb(null, true)
            } else {
                cb(new Error('Not allowed by Cors'))
            }
        },
        credentials: true,
        methods: ['GET', "POST", "PUT", "DELETE", "PATCH"],
        allowedHeaders: ['Content-Type', "Authorization"]
    }))

    // Public workspace routes (no auth) must be mounted BEFORE the protected ones
    app.use('/api/workspaces', publicWorkspaceRouter);
    app.use('/api/workspaces', workspaceRoutes);

    app.use('/api', authRouter);
    // Published docs, for anyone with the link (MANAGER_AND_DOCS_PLAN §2).
    app.use('/api/public', publicRouter);
    app.use('/api', tagQueryRouter)
    app.use('/api', otpRoutes);

    app.use('/api', todoRoutes);
    app.use('/api/workspace-todos', workspaceTodoRoutes);

    app.use('/api', userRoutes);

    // Learning (Revise's dashboard): /api/today, /api/revisions, /api/subjects, … (LEARNING_SPEC §2)
    app.use('/api', learningRoutes);

    // Agents (HOME_DOCS_AGENT_PLAN §3): the MCP server's API, and personal access tokens (cookie only).
    // Which endpoints accept a token at all: src/services/apiTokens/tokenRoutes.ts.
    app.use('/api/agent', agentRoutes);
    app.use('/api/tokens', apiTokenRoutes);
    // The database check (SELECT 1) for the owner's cookie (OWNER_EMAIL): src/routers/health.routes.ts.
    app.use('/api/health/db', healthDbRouter);
    // Canvas tools (CANVAS_BLOCK_SPEC §9, step 3): "Tidy up" and "Save as SVG/PNG" for a board.
    app.use('/api/canvas', canvasRoutes);

    // AI (HOME_DOCS_AGENT_PLAN §4, the Claude API): Recall mode and the spend meter. Cookie only;
    // 503 AI_NOT_CONFIGURED without CLAUDE_API_KEY.
    app.use('/api/recall', recallRoutes);
    app.use('/api/ai', aiRouter);
    app.use('/api/assistant', assistantRoutes);
    // The buddy (BUDDY_MEMORY_PLAN): what it knows about Ramin, its settings, the ways in.
    app.use('/api/buddy', buddyRoutes);
    // Stage 6 (ALWAYS_ON_SPEC): the phone's wallpaper + widget, and the morning notification.
    app.use('/api', alwaysOnRoutes);
    // The phone app (ANDROID_APP_SPEC): the page its connect code opens, and its file. Public.
    app.use(phoneRoutes);
    // Remote MCP over HTTP (ALWAYS_ON_SPEC 6.5): /mcp and its protected-resource metadata.
    app.use(mcpRoutes);
    app.use('/api/oauth', consentRouter);

    app.use('/api/docs', docRoutes);
    app.use('/api/docs/ai', docAiRoutes);
    app.use('/api/todos/ai', taskAiRoutes);
    app.use('/api/collab/upload', uploadRoutes);

    app.use('/api/notifications', notificationRoutes);
    app.use('/api/recent-visits', recentVisitRoutes);

    // import reminderRoutes from './routers/reminder.routes'
    // app.use('/api', reminderRoutes);

    app.use(errorHandler);

    return app;
}

const app = createApp();
export default app;
