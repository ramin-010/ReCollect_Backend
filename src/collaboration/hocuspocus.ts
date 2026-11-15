import { Server } from '@hocuspocus/server';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import * as Y from 'yjs';
import { allowedOrigins } from '../config/origins';

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
  /** The stored Yjs state (bytes, D3). */
  yjsState: Uint8Array | undefined;
  }

/**
 * What a live connection may do: 'edit' = read-write, 'view' = read-only (the connection gets
 * Hocuspocus `connectionConfig.readOnly`, so its document updates are neither applied, broadcast
 * nor stored; awareness such as cursors still works).
 */
export type CollabAccess = 'edit' | 'view';

export interface DocumentHandler {
  /** null = may not connect. */
  authorize(userId: string | null, docId: string): Promise<CollabAccess | null>;
  load(docId: string): Promise<CollabDocument | null>;
  save(docId: string, yjsState: Uint8Array): Promise<void>;
  cleanup?(docId: string): Promise<void>;
  /**
   * Fix the loaded state before anyone sees it (blocks the editor no longer has). Returns how
   * many repairs it made; when any, the repaired state is stored right away.
   */
  repair?(docId: string, document: Y.Doc): number;
}



const documentHandlers = new Map<string, DocumentHandler>();

export function registerDocumentHandler(prefix: string, handler: DocumentHandler) {
  documentHandlers.set(prefix, handler);

}

function parseDocumentName(documentName: string): { prefix: string; id: string } | null {
  const underscoreIndex = documentName.indexOf('_');
  if (underscoreIndex === -1) return null;
  
  return {
    prefix: documentName.substring(0, underscoreIndex),
    id: documentName.substring(underscoreIndex + 1),
  };
}


const activeConnections = new Map<string, any>();

/** Close code for "your rights on this doc changed": the editor reconnects at once, with the new rights. */
export const CLOSE_CODE_ACCESS_CHANGED = 4005;

/**
 * D6 (MANAGER_AND_DOCS_PLAN §1): someone's role on a doc changed, so their live connections close
 * (no message to the others) and their editor reconnects; Hocuspocus authorizes it again with the
 * new role, so a demoted editor can't keep writing. Returns how many connections were closed.
 */
export function refreshUserAccess(docId: string, userId: string): number {
  const documentName = `doc_${docId}`;
  let closed = 0;
  try {
    const server = hocuspocusServer as any;
    const documents = server.hocuspocus?.documents instanceof Map ? server.hocuspocus.documents : server.documents;
    const doc = documents instanceof Map ? documents.get(documentName) : undefined;
    if (doc?.connections instanceof Map) {
      for (const [socket, value] of doc.connections) {
        if (value?.connection?.context?.user?.id !== userId) continue;
        if (typeof socket.close === 'function') socket.close(CLOSE_CODE_ACCESS_CHANGED, 'ACCESS_CHANGED');
        else if (typeof socket.terminate === 'function') socket.terminate();
        closed += 1;
      }
    }
  } catch (err) {
    console.error(`[Collab] Error refreshing ${userId}'s access to ${docId}:`, err);
  }
  return closed;
}

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
    
        const documents = server.hocuspocus?.documents instanceof Map 
      ? server.hocuspocus.documents 
      : server.documents;
    
    if (documents instanceof Map) {
      const doc = documents.get(documentName);
      if (doc?.connections instanceof Map) {
        for (const [connKey, connValue] of doc.connections) {
          const connUserId = connValue?.connection?.context?.user?.id;
          
          if (connUserId === userId) {
                        
                        const messageType = isLeavingVoluntarily ? 'COLLABORATOR_LEFT' : 'COLLABORATOR_REMOVED';
            const payload = JSON.stringify({
              type: messageType,
              userId,
              name: connValue?.connection?.context?.user?.name || 'Unknown',
              remainingCount,
              removedBy 
            });
            
                        doc.connections.forEach((conn: any) => {
               if (conn.connection && typeof conn.connection.sendStateless === 'function') {
                                                         conn.connection.sendStateless(payload);
               } else if (conn.socket && typeof conn.socket.send === 'function') {
                                                     }
            });

                                                const closeCode = isLeavingVoluntarily ? 4002 : 4001;
            const closeReason = isLeavingVoluntarily ? 'LEFT_VOLUNTARILY' : 'REMOVED_BY_OWNER';
            
            if (typeof connKey.close === 'function') {
              connKey.close(closeCode, closeReason);
            } else if (typeof connKey.terminate === 'function') {
              connKey.terminate();
            }
          }
        }
      }
    }
    
        activeConnections.delete(key);
    return true;
    
  } catch (err) {
    console.error(`[Collab] Error disconnecting ${userId} from ${docId}:`, err);
    return false;
  }
}


// Users live in Postgres now (same JWT as the REST API).
import { findUserById } from '../services/users/users.service';

async function authenticateUser(token: string): Promise<CollabUser | null> {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET not configured');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id?: unknown };
    const user = typeof decoded.id === 'string' ? await findUserById(decoded.id) : null;

    if (!user) return null;

    return {
      id: user.id,
      name: user.name || '',
      email: user.email || '',
      avatar: user.avatar as string | undefined,
      color: getRandomColor(user.id),
    };
  } catch {
    return null;
  }
}

function getRandomColor(userId: string): string {
  const colors = [
    '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
    '#2196F3', '#03A9F4', '#00BCD4', '#009688', '#4CAF50',
    '#dcf1c4ff', '#CDDC39', '#FFC107', '#FF9800', '#FF5722',
  ];
  
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  return colors[Math.abs(hash) % colors.length]!;
}


export const hocuspocusServer = new Server({
  port: parseInt(process.env.COLLAB_PORT || '1234'),
  debounce: 2000,
  maxDebounce: 10000,
  
  async onAuthenticate({ token, documentName, request, connectionConfig }) {
    // CSWSH Protection: Validate Origin header before any auth logic.
    // Browsers always send the Origin header on WebSocket upgrades.
    // A missing Origin means a non-browser client (not vulnerable to CSWSH).
    if (request) {
      const origin = request.headers?.origin;
      // The same list as the API's CORS (src/config/origins.ts: ALLOWED_ORIGINS, else the defaults).
      if (origin && !allowedOrigins().includes(origin)) {
        throw new Error(`Origin not allowed: ${origin}`);
      }
    }

    const parsed = parseDocumentName(documentName);
    if (!parsed) {
      throw new Error('Invalid document name format');
    }

    const handler = documentHandlers.get(parsed.prefix);
    if (!handler) {
      throw new Error(`No handler registered for: ${parsed.prefix}`);
    }
    let authToken = token;
    if (!authToken && request && (request as any).headers?.cookie) {
      const cookies = (request as any).headers.cookie.split(';');
      const tokenCookie = cookies.find((c: string) => c.trim().startsWith('token='));
      if (tokenCookie) {
        authToken = tokenCookie.split('=')[1].trim();
      }
    }
    let user: CollabUser | null = null;
    if (authToken) {
      user = await authenticateUser(authToken);
    }
    if (user) {
      const access = await handler.authorize(user.id, parsed.id);
      if (!access) {
        throw new Error('Not authorized to edit this document');
      }
      // Viewers may watch live but not write: Hocuspocus rejects their Yjs updates.
      connectionConfig.readOnly = access !== 'edit';

      const key = `${documentName}:${user.id}`;
      activeConnections.set(key, { userId: user.id, documentName, user });
      
      return { user };
    }

    // No anonymous (guest) connections: a doc share link only leads to an access request.
    throw new Error('Authentication required');
  },



  async onLoadDocument({ documentName, document }) {
    const parsed = parseDocumentName(documentName);
    if (!parsed) return document;

    const handler = documentHandlers.get(parsed.prefix);
    if (!handler) return document;
    
    try {


      const doc = await handler.load(parsed.id);
      
      if (doc?.yjsState) Y.applyUpdate(document, doc.yjsState);
      // Changes made while loading are not stored by Hocuspocus, so a repair is saved here.
      if (handler.repair && handler.repair(parsed.id, document) > 0) {
        await handler.save(parsed.id, Y.encodeStateAsUpdate(document));
      }
    } catch (error) {
      console.error(`[Hocuspocus] ❌ Error loading ${parsed.prefix}:${parsed.id}:`, error);
    }

    return document;
  },

    async onStoreDocument({ documentName, document }) {
    const parsed = parseDocumentName(documentName);
    if (!parsed) return;

    const handler = documentHandlers.get(parsed.prefix);
    if (!handler) return;

    try {
      await handler.save(parsed.id, Y.encodeStateAsUpdate(document));
    } catch (error) {
      console.error(`[Collab] Error saving ${parsed.prefix}:${parsed.id}:`, error);
    }
  },

    async onConnect(data: any) {
    const { documentName, context } = data;
    const parsed = parseDocumentName(documentName);
    console.log(`[Collab] Connected: ${parsed?.prefix}:${parsed?.id} - ${context?.user?.name || '(pending auth)'}`);
  },

  async onDisconnect({ documentName, context }: { documentName: string; context: any }) {
    const parsed = parseDocumentName(documentName);
    console.log(`[Collab] Disconnected: ${parsed?.prefix}:${parsed?.id} - ${context?.user?.name}`);
    
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
