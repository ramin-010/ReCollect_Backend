// All Prisma row → old (Mongo-shaped) JSON serializers. Import from here or from the module file
// directly (e.g. '../../db/serializers/doc'); both work. Todo shapes live in
// src/services/todos/todoShape.ts.
export { withMongoId, withMongoIds } from './common';
export {
    userSummarySelect,
    serializeUser,
    serializeUserSummary,
    serializeUserSummaryOrNull,
} from './user';
export type { UserJson, UserSummaryJson, UserSummaryRow, SafeUserRow } from './user';
export * from './doc';
export * from './docSharing';
export * from './notification';
export * from './recentVisit';
export * from './workspace';
export * from './learning';
export * from './recall';
export * from './coach';
