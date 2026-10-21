/** ECO's own targets. Never substitute FCUNO/FCOS credentials or project references. */
export const ecoConnections = Object.freeze({
  productionOrigin: 'https://eco.fcuno.com',
  githubRepository: 'hocheunglai-oss/ecosystem-public',
  vercel: { projectName: 'ecosystem', teamId: 'team_MbKDazzCrou3eKTuausPv4X2', projectId: 'prj_jbxIXe5jo2E3VRTe0r5scMdZUmeR' },
  // Provisioned and independently verified on 13 October 2026.
  supabaseProjectRef: 'cucfyycoklddufdluahi' as string | null,
  supabaseOrganizationId: 'yxyxcenpgqutvoctrdkj',
  supabaseRegion: 'ap-southeast-1',
  supplierReportsBucket: 'eco-supplier-reports',
  // Verified ECO-only Microsoft metadata. Unverified app/source pins keep intake closed.
  emailReceiver: Object.freeze({
    tenantId: '70011d0d-19b4-4a61-8195-ab1fd987c20f',
    clientId: '9b27a0c4-419d-4faa-b18b-406024ba79ff' as string | null,
    mailboxId: '04a46624-be0f-4e5e-bef0-e39c77493155',
    sourceId: 'c501b894-3fa8-4956-916b-49aeffc6bb1c' as string | null,
  }),
  // A dedicated ECO Meta app must be verified before message intake is enabled.
  whatsappReceiver: Object.freeze({
    businessPortfolioId: '180037296385138' as string | null,
    appId: '2211569939780190' as string | null,
    accountId: '1583446799892454' as string | null,
    phoneNumberId: '1167117349823397' as string | null,
    displayPhoneNumber: '+85298472818',
    sourceId: '618387b9-b70f-409d-a24d-971916204c35' as string | null,
    graphApiVersion: 'v26.0' as string | null,
    identityNamespace: 'meta-whatsapp-signed-v1',
  }),
  identityMode: 'independent-password' as const,
});
