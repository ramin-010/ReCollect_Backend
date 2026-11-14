
export { startCollaborationServer, registerDocumentHandler } from './hocuspocus';
export type { DocumentHandler, CollabAccess, CollabUser, CollabDocument } from './hocuspocus';

import { registerDocHandler } from './docHandler';

export function initializeCollaboration() {
  registerDocHandler();
}

