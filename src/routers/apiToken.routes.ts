// /api/tokens: personal access tokens. Cookie sessions only: an access token gets a 403 here
// (authMiddleware already refuses it: /api/tokens is not in src/services/apiTokens/tokenRoutes.ts).
import express from 'express';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import { createToken, listTokens, revokeToken } from '../controllers/apiToken.controller';

const router = express.Router();

router.use(authOnce, cookieOnly);

router.get('/', listTokens);
router.post('/', createToken);
router.delete('/:id', revokeToken);

export default router;
