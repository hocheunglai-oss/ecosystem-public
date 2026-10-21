import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const base=process.env.ECO_DEMO_URL||'http://127.0.0.1:4181';
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
await mkdir('artifacts/attachments',{recursive:true});
try{for(const [width,theme]of [[1440,'light'],[1280,'dark'],[390,'light'],[320,'light']]){
 const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<700,reducedMotion:'reduce'});
 await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
 await context.route('**/*',route=>route.request().method()!=='GET'||new URL(route.request().url()).pathname.startsWith('/api/')?route.abort():route.continue());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
 async function openPort(){const nav=page.getByRole('navigation',{name:'Workspace navigation'});await button(nav,'Ports & Suppliers').click();await button(nav,'Countries & Ports').click();const ports=page.getByRole('dialog',{name:'Countries & Ports',exact:true});await button(ports,'Port Index').click();await ports.getByLabel('Country or port',{exact:true}).fill('Singapore');await button(ports.locator('.location-table'),'Singapore').click();return ports;}
 try{
  await page.goto(base);await page.getByLabel('Demo profile',{exact:true}).selectOption('otto');await button(page,'ENTER ECOSYSTEM').click();
  let ports=await openPort();let block=ports.locator('.knowledge-block').first();const blockTitle=await block.locator('h4').innerText();
  await block.locator('.attachments-trigger').click();let dialog=page.getByRole('dialog',{name:'Attachments',exact:true});
  await expect(dialog).toHaveAttribute('data-window-size','expanded');await expect(dialog.getByRole('navigation',{name:'Attachment path'})).toContainText('Singapore (Port)');
  await expect(dialog.locator('.attachment-folder-header h3')).toHaveText(blockTitle,{ignoreCase:true});
  const bytes=Buffer.from('Case sensitive original\nSupporting evidence.');
  await dialog.getByLabel('Upload attachments',{exact:true}).setInputFiles([{name:'Reference.txt',mimeType:'text/plain',buffer:bytes},{name:'Supporting.dat',mimeType:'application/octet-stream',buffer:Buffer.from([0,1,2,3,255])}]);
  await expect(dialog.locator('.attachment-footer')).toContainText('2 files saved');
  await button(dialog,'Add link').click();await dialog.getByLabel('Name',{exact:true}).fill('Authority link');await dialog.getByLabel('URL',{exact:true}).fill('javascript:alert(1)');await button(dialog,'Save').click();await expect(dialog.getByRole('alert')).toContainText('http or https');
  await dialog.getByLabel('URL',{exact:true}).fill('https://example.com/CaseSensitive.pdf?Token=AbC');await button(dialog,'Save').click();await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Authority link'})).toBeVisible();
  await dialog.locator('.attachment-file-tile').filter({hasText:'Reference.txt'}).click();await expect(dialog.locator('.attachment-preview pre')).toHaveText(bytes.toString());
  const downloadPromise=page.waitForEvent('download');await dialog.getByRole('link',{name:'Download',exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'Reference.txt');const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
  await button(dialog,'Rename').click();await dialog.getByLabel('Name',{exact:true}).fill('Renamed.txt');await button(dialog,'Save').click();await expect(dialog.locator('.attachment-inspector h3')).toHaveText('Renamed.txt');
  await button(dialog,'Close attachment details').click();await button(dialog,'New folder').click();await dialog.getByLabel('Name',{exact:true}).fill('Supporting evidence');await button(dialog,'Save').click();
  await dialog.locator('.attachment-file-tile').filter({hasText:'Supporting.dat'}).click();await expect(dialog.getByText('Preview unavailable. Download to open.')).toBeVisible();
  await button(dialog,'Move').click();const options=await dialog.getByLabel('Move destination').locator('option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,text:n.textContent})));const dest=options.find(n=>n.text.endsWith('/ Supporting evidence'));assert.ok(dest);await dialog.getByLabel('Move destination').selectOption(dest.value);await button(dialog.locator('.attachment-form'),'Move').click();
  await dialog.locator('.attachment-folder-tile').filter({hasText:'Supporting evidence'}).click();await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Supporting.dat'})).toBeVisible();
  await button(dialog,'Back').click();await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Renamed.txt'})).toBeVisible();await button(dialog,'Forward').click();await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Supporting.dat'})).toBeVisible();await button(dialog,'Back').click();
  if(width>700){
   const tile=dialog.locator('.attachment-file-tile').filter({hasText:'Renamed.txt'}),target=dialog.locator('.attachment-folder-tile').filter({hasText:'Supporting evidence'});
   const data=await page.evaluateHandle(()=>new DataTransfer());await tile.dispatchEvent('dragstart',{dataTransfer:data});await target.dispatchEvent('dragover',{dataTransfer:data});
   await expect(dialog.locator('.attachment-drop-indicator')).toContainText('Supporting evidence');await expect(target).toHaveAttribute('data-drop-target','');
   await dialog.locator('.attachment-toolbar').dispatchEvent('dragover',{dataTransfer:data});await expect(dialog.locator('.attachment-drop-indicator')).toHaveCount(0);await target.dispatchEvent('dragover',{dataTransfer:data});await expect(dialog.locator('.attachment-drop-indicator')).toContainText('Supporting evidence');
   await target.dispatchEvent('drop',{dataTransfer:data});await expect(tile).toHaveCount(0);
   await target.click();await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Renamed.txt'})).toBeVisible();await button(dialog,'Back').click();
  }
  await button(dialog,'Grid view').click();await expect(dialog.locator('.attachment-files')).toHaveClass(/--grid/);await button(dialog,'List view').click();
  await button(dialog,'Shrink window').click();await expect(dialog).toHaveAttribute('data-window-size','compact');await dialog.getByLabel('Search attachments').fill('Renamed');await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Renamed.txt'})).toBeVisible();await button(dialog,'Expand window').click();await expect(dialog.getByLabel('Search attachments')).toHaveValue('RENAMED');
  await dialog.getByLabel('Search attachments').fill('');
  await page.screenshot({path:`artifacts/attachments/browser-${width}-${theme}.png`});
  assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'No dialog overflow');assert.ok(await dialog.locator('.attachment-browser').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'No browser overflow');
  await button(dialog,'Close dialog').click();await expect(block.locator('.attachments-trigger')).toContainText('(3)');await expect(block.locator('.attachments-trigger')).toBeFocused();
  await page.reload();ports=await openPort();block=ports.locator('.knowledge-block').first();await expect(block.locator('.attachments-trigger')).toContainText('(3)');await block.locator('.attachments-trigger').click();dialog=page.getByRole('dialog',{name:'Attachments',exact:true});
  await dialog.getByLabel('Search attachments').fill('Authority link');await dialog.locator('.attachment-file-tile').filter({hasText:'Authority link'}).click();await expect(dialog.getByRole('link',{name:'Open link'})).toHaveAttribute('href','https://example.com/CaseSensitive.pdf?Token=AbC');
  await button(dialog,'Delete').click();await button(dialog.locator('.attachment-form'),'Delete').click();await expect(dialog.locator('.attachment-footer')).toContainText('Attachment deleted');await button(dialog,'Close dialog').click();await expect(block.locator('.attachments-trigger')).toContainText('(2)');
  if(width===1440){
   await button(page,'Close workspace').click();const nav=page.getByRole('navigation',{name:'Workspace navigation'});await button(nav,'Buyers and Credit').click();await button(nav,'Buyer Profiles').click();
   let workspace=page.getByRole('dialog',{name:'Buyer Profiles',exact:true});const company=await page.evaluate(()=>JSON.parse(localStorage.getItem('ecosystem.demo.v1')).companies.find(item=>item.id==='company-meridian'));
   await workspace.getByRole('textbox',{name:'Search buyer profiles'}).fill(company.name);await button(workspace,company.name).click();const profile=workspace.locator('.buyer-profile:visible');const buyerButton=profile.locator('.buyer-profile__header .attachments-trigger');const initialCount=Number((await buyerButton.innerText()).match(/\((\d+)\)/)?.[1]??0);
   await buyerButton.click();dialog=page.getByRole('dialog',{name:'Attachments',exact:true});await expect(dialog.getByRole('navigation',{name:'Attachment path'})).toContainText('Buyers');
   await dialog.getByLabel('Upload attachments',{exact:true}).setInputFiles({name:'Buyer.txt',mimeType:'text/plain',buffer:Buffer.from('Buyer supporting file')});await expect(dialog.locator('.attachment-footer')).toContainText('1 file saved');await button(dialog,'Close dialog').click();await expect(buyerButton).toContainText(`(${initialCount+1})`);
   const creditButton=profile.getByRole('region',{name:'Credit Information',exact:true}).locator('.attachments-trigger');await creditButton.click();dialog=page.getByRole('dialog',{name:'Attachments',exact:true});await expect(dialog.getByRole('navigation',{name:'Attachment path'})).toContainText('Credit');
   await dialog.getByLabel('Upload attachments',{exact:true}).setInputFiles({name:'Credit.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nDemo supporting document')});await expect(dialog.locator('.attachment-footer')).toContainText('1 file saved');await dialog.locator('.attachment-file-tile').filter({hasText:'Credit.pdf'}).click();await expect(dialog.getByText('Preview unavailable. Download to open.')).toBeVisible();await expect(dialog.getByRole('link',{name:'Download',exact:true})).toBeVisible();await button(dialog,'Close dialog').click();await expect(creditButton).toContainText('(1)');
   await button(page,'Close workspace').click();await button(nav,'Credit Requests').click();workspace=page.getByRole('dialog',{name:'Credit Requests',exact:true});await workspace.locator('.credit-record-heading .attachments-trigger').click();dialog=page.getByRole('dialog',{name:'Attachments',exact:true});await expect(dialog.locator('.attachment-folder-header h3')).toHaveText('Credit');await dialog.getByLabel('Search attachments').fill('Credit.pdf');await expect(dialog.locator('.attachment-file-tile').filter({hasText:'Credit.pdf'})).toBeVisible();await button(dialog,'Close dialog').click();
   await workspace.locator('.credit-record-expand').first().click();await workspace.locator('.credit-record-detail .attachments-trigger').click();dialog=page.getByRole('dialog',{name:'Attachments',exact:true});await expect(dialog.getByRole('navigation',{name:'Attachment path'})).toContainText('Credit');await expect(dialog.locator('.attachment-folder-header h3')).not.toHaveText('Credit');await button(dialog,'Close dialog').click();
   console.log('PASS buyer and credit scopes, title bar counts and request folders');
  }
  assert.deepEqual(errors,[]);console.log(`PASS ${width} ${theme}: attachments, persistence, navigation, previews, download, move and counts`);
 }finally{await context.close();}
}}finally{await browser.close();}
