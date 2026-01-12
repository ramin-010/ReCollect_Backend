import { Server } from '@hocuspocus/server';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import * as Y from 'yjs';

dotenv.config();

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
  // content?: any;   #legacy
}

export interface DocumentHandler {
  authorize(userId: string, docId: string): Promise<boolean>;
  load(docId: string): Promise<CollabDocument | null>;
  save(docId: string, yjsState: string): Promise<void>;
  cleanup?(docId: string): Promise<void>;
}

// ============================================
// DOCUMENT HANDLER REGISTRY


const documentHandlers = new Map<string, DocumentHandler>();

export function registerDocumentHandler(prefix: string, handler: DocumentHandler) {
  documentHandlers.set(prefix, handler);
  console.log(`[Collab] Registered handler for: ${prefix}`);
}

function parseDocumentName(documentName: string): { prefix: string; id: string } | null {
  const underscoreIndex = documentName.indexOf('_');
  if (underscoreIndex === -1) return null;
  
  return {
    prefix: documentName.substring(0, underscoreIndex),
    id: documentName.substring(underscoreIndex + 1),
  };
}

// ============================================
// CONNECTION REGISTRY
// Track active connections to enable force-disconnect
// ============================================

// Map<"documentName:userId", connectionData>
const activeConnections = new Map<string, any>();

/**
 * Force disconnect a specific user from a document.
 * Called when owner removes a collaborator or when a user leaves.
 * @param isLeavingVoluntarily - true if user is leaving themselves, false if owner kicked them
 * @param removedBy - ID of the user who initiated the removal (optional)
 */
export function disconnectUser(docId: string, userId: string, remainingCount: number = 0, isLeavingVoluntarily: boolean = false, removedBy?: string): boolean {
  const documentName = `doc_${docId}`;
  const key = `${documentName}:${userId}`;
  
  try {
    const server = hocuspocusServer as any;
    
    // Access documents from Hocuspocus server
    const documents = server.hocuspocus?.documents instanceof Map 
      ? server.hocuspocus.documents 
      : server.documents;
    
    if (documents instanceof Map) {
      const doc = documents.get(documentName);
      if (doc?.connections instanceof Map) {
        for (const [connKey, connValue] of doc.connections) {
          const connUserId = connValue?.connection?.context?.user?.id;
          
          if (connUserId === userId) {
            // Found the user to remove!
            
            // Broadcast different message types based on how user is leaving
            const messageType = isLeavingVoluntarily ? 'COLLABORATOR_LEFT' : 'COLLABORATOR_REMOVED';
            const payload = JSON.stringify({
              type: messageType,
              userId,
              name: connValue?.connection?.context?.user?.name || 'Unknown',
              remainingCount,
              removedBy 
            });
            
            // Broadcast to all connections on this document
            doc.connections.forEach((conn: any) => {
               if (conn.connection && typeof conn.connection.sendStateless === 'function') {
                   // Ensure we don't send to the user being removed (optional, but cleaner)
                   // Actually, we can send to everyone, the removed user will be disconnected anyway
                   conn.connection.sendStateless(payload);
               } else if (conn.socket && typeof conn.socket.send === 'function') {
                   // Fallback for raw socket if stateless not available
                   // Note: Hocuspocus might expect specific frame for stateless
               }
            });

            // 2. Disconnect the target user with appropriate close code
            // 4001 = Removed by owner (triggers "Access Revoked" modal)
            // 4002 = Left voluntarily (no modal needed)
            const closeCode = isLeavingVoluntarily ? 4002 : 4001;
            const closeReason = isLeavingVoluntarily ? 'LEFT_VOLUNTARILY' : 'REMOVED_BY_OWNER';
            
            if (typeof connKey.close === 'function') {
              connKey.close(closeCode, closeReason);
            } else if (typeof connKey.terminate === 'function') {
              connKey.terminate();
            }
            console.log(`[Collab] Force disconnected user ${userId} from ${docId} (${closeReason})`);
          }
        }
      }
    }
    
    // Clean up our registry
    activeConnections.delete(key);
    return true;
    
  } catch (err) {
    console.error(`[Collab] Error disconnecting ${userId} from ${docId}:`, err);
    return false;
  }
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
  
  async onAuthenticate({ token, documentName, request }) {
    let authToken = token;

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

    // Register connection for potential force-disconnect
    // We do this in onAuthenticate because user info is available here
    const key = `${documentName}:${user.id}`;
    activeConnections.set(key, { userId: user.id, documentName, user });
    console.log(`[Collab] Registered connection in auth: ${key}`);

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

  // Connection logging (registration happens in onAuthenticate)
  async onConnect(data: any) {
    const { documentName, context } = data;
    const parsed = parseDocumentName(documentName);
    console.log(`[Collab] Connected: ${parsed?.prefix}:${parsed?.id} - ${context?.user?.name || '(pending auth)'}`);
  },

  async onDisconnect({ documentName, context }: { documentName: string; context: any }) {
    const parsed = parseDocumentName(documentName);
    console.log(`[Collab] Disconnected: ${parsed?.prefix}:${parsed?.id} - ${context?.user?.name}`);
    
    // Remove from connection registry
    if (context?.user?.id) {
      const key = `${documentName}:${context.user.id}`;
      activeConnections.delete(key);
      console.log(`[Collab] Unregistered connection: ${key}`);
    }
    
    if (parsed) {
      const handler = documentHandlers.get(parsed.prefix);
      if (handler?.cleanup) {
        try {
          console.log(`[Collab] Cleanup: ${parsed.prefix}:${parsed.id}`);
          await handler.cleanup(parsed.id);
        } catch (err) {
          console.error(`[Collab] Cleanup error for ${parsed.prefix}:${parsed.id}:`, err);
        }
      }
    }
  },
});

export function startCollaborationServer() {
  hocuspocusServer.listen();
  console.log(`🔄 Collaboration server running on ws://localhost:${process.env.COLLAB_PORT || '1234'}`);
}
