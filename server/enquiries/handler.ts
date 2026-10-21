import type { AdministrationGateway } from '../admin/handler.ts';
import { ApiError } from '../auth/validation.ts';
/** This control metadata does not grant test-data or mutation access. SQL verifies the real identity. */
export async function handleEnquiryPolicy(request: Request, gateway: AdministrationGateway): Promise<Response> {
 const headers=new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});
 let value:unknown;let status=200;
 try {
  if(request.method!=='GET')throw new ApiError(405,'Method not allowed.');
  const url=new URL(request.url);if(url.pathname!=='/api/enquiries/test-policy'||url.search)throw new ApiError(404,'Not found.');
  const actor=await gateway.currentUser();if(!actor?.isActive||!actor.activated)throw new ApiError(401,'Sign in required.');
  value=await gateway.authenticatedRpc('eco_test_workspace_policy');
 }catch(error){status=error instanceof ApiError?error.status:503;value={message:error instanceof ApiError?error.message:'Test workspace unavailable.'};}
 for(const cookie of gateway.cookies)headers.append('Set-Cookie',cookie);
 return new Response(JSON.stringify(value),{status,headers});
}
