import { Server } from '@hocuspocus/server';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import * as Y from 'yjs';

dotenv.config();

// ============================================
// REUSABLE DOCUMENT HANDLER INTERFACE
// ============================================

export interface CollabUser {
  id: string;
  name: string;
  email: string;
  avatar: string | undefined;
  color: string;
}

export interface CollabDocument {
  id: string;
  yjsState: string | undefined;
  content?: any;
}

// Each document type (docs, content, etc.) implements this handler
export interface DocumentHandler {
  // Check if user can edit this document
  authorize(userId: string, docId: string): Promise<boolean>;
  // Load document from database
  load(docId: string): Promise<CollabDocument | null>;
  // Save Yjs state to database
  save(docId: string, yjsState: string): Promise<void>;
}

// ============================================
// DOCUMENT HANDLER REGISTRY
// ============================================

const documentHandlers = new Map<string, DocumentHandler>();

// Register a new document type handler
export function registerDocumentHandler(prefix: string, handler: DocumentHandler) {
  documentHandlers.set(prefix, handler);
  console.log(`[Collab] Registered handler for: ${prefix}`);
}

// Parse document name to get prefix and ID
// Format: "prefix_documentId" e.g., "doc_123abc" or "content_456def"
function parseDocumentName(documentName: string): { prefix: string; id: string } | null {
  const underscoreIndex = documentName.indexOf('_');
  if (underscoreIndex === -1) return null;
  
  return {
    prefix: documentName.substring(0, underscoreIndex),
    id: documentName.substring(underscoreIndex + 1),
  };
}

// ============================================
// USER UTILITIES
// ============================================

import User from '../models/userSchema';

async function authenticateUser(token: string): Promise<CollabUser | null> {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET not configured');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: string };
    const user = await User.findById(decoded.id).select('-password') as any;
    
    if (!user) return null;

    return {
      id: user._id.toString(),
      name: user.name || '',
      email: user.email || '',
      avatar: user.avatar as string | undefined,
      color: getRandomColor(user._id.toString()),
    };
  } catch {
    return null;
  }
}

function getRandomColor(userId: string): string {
  const colors = [
    '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
    '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50',
    '#8BC34A', '#CDDC39', '#FFC107', '#FF9800', '#FF5722',
  ];
  
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length]!;
}

// ============================================
// HOCUSPOCUS SERVER CONFIGURATION
// ============================================

export const hocuspocusServer = new Server({
  port: parseInt(process.env.COLLAB_PORT || '1234'),
  
  // Authentication - validate JWT and document access
  async onAuthenticate({ token, documentName, request }) {
    let authToken = token;

    // If no token provided (client couldn't read HttpOnly cookie), try to get it from request headers
    if (!authToken && request && (request as any).headers?.cookie) {
      const cookies = (request as any).headers.cookie.split(';');
      const tokenCookie = cookies.find((c: string) => c.trim().startsWith('token='));
      if (tokenCookie) {
        authToken = tokenCookie.split('=')[1].trim();
      }
    }

    if (!authToken) {
      throw new Error('No token provided');
    }

    const user = await authenticateUser(authToken);
    if (!user) {
      throw new Error('Invalid token');
    }

    const parsed = parseDocumentName(documentName);
    if (!parsed) {
      throw new Error('Invalid document name format');
    }

    const handler = documentHandlers.get(parsed.prefix);
    if (!handler) {
      throw new Error(`No handler registered for: ${parsed.prefix}`);
    }

    const canEdit = await handler.authorize(user.id, parsed.id);
    if (!canEdit) {
      throw new Error('Not authorized to edit this document');
    }

    return { user };
  },

  // Load document from database
  async onLoadDocument({ documentName, document }) {
    const parsed = parseDocumentName(documentName);
    if (!parsed) return document;

    const handler = documentHandlers.get(parsed.prefix);
    if (!handler) return document;

    try {
      const doc = await handler.load(parsed.id);
      
      if (doc?.yjsState) {
        const state = Buffer.from(doc.yjsState, 'base64');
        Y.applyUpdate(document, state);
        console.log(`[Collab] Loaded ${parsed.prefix}:${parsed.id}`);
      }
    } catch (error) {
      console.error(`[Collab] Error loading ${parsed.prefix}:${parsed.id}:`, error);
    }

    return document;
  },

  // Store document to database on changes
  async onStoreDocument({ documentName, document }) {
    const parsed = parseDocumentName(documentName);
    if (!parsed) return;

    const handler = documentHandlers.get(parsed.prefix);
    if (!handler) return;

    try {
      const state = Y.encodeStateAsUpdate(document);
      const stateBase64 = Buffer.from(state).toString('base64');
      
      await handler.save(parsed.id, stateBase64);
      console.log(`[Collab] Saved ${parsed.prefix}:${parsed.id}`);
    } catch (error) {
      console.error(`[Collab] Error saving ${parsed.prefix}:${parsed.id}:`, error);
    }
  },

  // Connection logging
  async onConnect({ documentName, context }: { documentName: string; context: any }) {
    const parsed = parseDocumentName(documentName);
    console.log(`[Collab] Connected: ${parsed?.prefix}:${parsed?.id} - ${context?.user?.name}`);
  },

  async onDisconnect({ documentName, context }: { documentName: string; context: any }) {
    const parsed = parseDocumentName(documentName);
    console.log(`[Collab] Disconnected: ${parsed?.prefix}:${parsed?.id} - ${context?.user?.name}`);
  },
});

export function startCollaborationServer() {
  hocuspocusServer.listen();
  console.log(`🔄 Collaboration server running on ws://localhost:${process.env.COLLAB_PORT || '1234'}`);
}
