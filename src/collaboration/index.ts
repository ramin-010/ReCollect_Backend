
export { startCollaborationServer, registerDocumentHandler } from './hocuspocus';
export type { DocumentHandler, CollabUser, CollabDocument } from './hocuspocus';

import { registerDocHandler } from './docHandler';
import { registerDrawingHandler } from './drawingHandler';

export function initializeCollaboration() {
  registerDocHandler();
  registerDrawingHandler();
}
