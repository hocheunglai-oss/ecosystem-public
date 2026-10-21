export async function installProfileTabMocks(context,{ownerId=()=> '10000000-0000-4000-8000-000000000001',preview=()=>false,canManageShared=()=>true}={}){
 const state={shared:new Map(),private:new Map(),requests:[],receipts:new Map()};
 const get=(target)=>{const key=`${target.kind}:${target.id}`;return {target,shared:structuredClone(state.shared.get(key)||{revision:0,tabs:[]}),private:preview()?{revision:0,tabs:[]}:structuredClone(state.private.get(`${ownerId()}:${key}`)||{revision:0,tabs:[]})};};
 await context.route('**/api/profile-tabs/**',route=>{
  const request=route.request(),url=new URL(request.url());
  if(request.method()==='GET')return route.fulfill({json:get({kind:url.searchParams.get('kind'),id:url.searchParams.get('id')})});
  const body=request.postDataJSON();state.requests.push(body);
  if(preview()||(body.visibility==='shared'&&!canManageShared()))return route.fulfill({status:403,json:{message:'Read only.'}});
  if(state.receipts.has(body.requestId))return route.fulfill({json:state.receipts.get(body.requestId)});
  const current=get(body.target),scope=current[body.visibility];if(body.revision!==scope.revision)return route.fulfill({status:409,json:{message:'Tabs changed. Reload the latest record.'}});
  const key=`${body.target.kind}:${body.target.id}`;(body.visibility==='shared'?state.shared:state.private).set(body.visibility==='shared'?key:`${ownerId()}:${key}`,{revision:scope.revision+1,tabs:body.tabs});
  const result=get(body.target);state.receipts.set(body.requestId,result);return route.fulfill({json:result});
 });
 await context.route('**/api/supplier-reports/**',route=>route.fulfill({json:{items:[]}}));
 return state;
}
