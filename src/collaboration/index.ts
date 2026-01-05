// Collaboration Module Entry Point
// 
// To add collaboration for a new feature:
// 1. Create a handler file (e.g., contentHandler.ts)
// 2. Implement the DocumentHandler interface
// 3. Import and call the register function here
// 4. Frontend connects with documentName: `prefix_id`

export { startCollaborationServer, registerDocumentHandler } from './hocuspocus';
export type { DocumentHandler, CollabUser, CollabDocument } from './hocuspocus';

// Register handlers
import { registerDocHandler } from './docHandler';

export function initializeCollaboration() {
  registerDocHandler();
}
