import { serveAccess } from '../../../server/auth/node.ts';

// Explicit nested routes are required by the Vercel Node filesystem router.
export default serveAccess;
