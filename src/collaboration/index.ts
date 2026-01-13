
export { startCollaborationServer, registerDocumentHandler } from './hocuspocus';
export type { DocumentHandler, CollabUser, CollabDocument } from './hocuspocus';

import { registerDocHandler } from './docHandler';

export function initializeCollaboration() {
  registerDocHandler();
}
