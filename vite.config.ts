import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { serveAccess } from './server/auth/node.ts';
import { serveAdministration } from './server/admin/node.ts';
import { serveSuppliers } from './server/suppliers/node.ts';
import { serveSupplierReports } from './server/supplier-reports/node.ts';
import { serveProfileTabs } from './server/profile-tabs/node.ts';
import { serveEnquiryPolicy } from './server/enquiries/node.ts';
import { serveParser } from './server/parser/node.ts';
import { serveInbox } from './server/inbox/node.ts';
import { serveEmailSync } from './server/inbox-email/node.ts';
import { serveIntelligence } from './server/intelligence/node.ts';
export default defineConfig(({ mode }) => {
  // Load server-only ECO variables for the local API; none are injected into client code.
  const accessEnvironment = { ...process.env, ...loadEnv(mode, process.cwd(), 'ECO_'), ...loadEnv(mode, process.cwd(), 'OPENAI_') };
  return {
  plugins: [react(), {
    name: 'eco-access-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/access/')) void serveAccess(req, res, accessEnvironment);
        else if (req.url?.split('?')[0] === '/api/enquiries/email-sync') void serveEmailSync(req, res, accessEnvironment);
        else if (req.url?.split('?')[0] === '/api/enquiries/inbox') void serveInbox(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/enquiries/')) void serveEnquiryPolicy(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/parser/')) void serveParser(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/supplier-reports/')) void serveSupplierReports(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/profile-tabs/')) void serveProfileTabs(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/suppliers/')) void serveSuppliers(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/intelligence/')) void serveIntelligence(req, res, accessEnvironment);
        else if (req.url?.startsWith('/api/admin/')) void serveAdministration(req, res, accessEnvironment);
        else next();
      });
    },
  }],
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173 },
  };
});
