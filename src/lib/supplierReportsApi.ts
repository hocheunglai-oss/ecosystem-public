import type { SupplierReport } from '../../shared/supplierReports';
async function request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
 const response=await fetch(`/api/supplier-reports/${path}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-Eco-Request':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 const result=await response.json().catch(()=>({message:'Reports unavailable.'}));if(!response.ok)throw new Error(result.message??'Reports unavailable.');return result as T;
}
export const supplierReportsApi={list:(supplierId:string,signal?:AbortSignal)=>request<{items:SupplierReport[]}>(`list?supplierId=${encodeURIComponent(supplierId)}`,undefined,signal),download:(id:string)=>request<{url:string;expiresAt:string}>('download',{id})};
