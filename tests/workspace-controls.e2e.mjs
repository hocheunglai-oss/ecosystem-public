import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const base=process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
await mkdir('artifacts/buyer-profile',{recursive:true});
try {
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<1000,hasTouch:width<1000});
  try{
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);await page.getByLabel('Demo profile',{exact:true}).selectOption('otto');await page.getByRole('button',{name:'ENTER ECOSYSTEM',exact:true}).click();
   const nav=page.getByRole('navigation',{name:'Workspace navigation'});
   await nav.getByRole('button',{name:'Credit',exact:true}).click();await nav.getByRole('button',{name:'Buyer Profile',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'Buyer Profile',exact:true});
   await expect(dialog.getByRole('region',{name:'Recent margin and volume trends',exact:true})).toBeVisible();
   await dialog.locator('.window-foot').getByRole('button',{name:'Dark mode',exact:true}).click();
   await expect(page.locator('html')).toHaveAttribute('data-theme','dark',{timeout:30000});
   await expect(dialog).toBeVisible();
   await dialog.locator('.window-foot').getByRole('button',{name:'Light mode',exact:true}).click();
   await expect(page.locator('html')).toHaveAttribute('data-theme','light',{timeout:30000});
   await dialog.getByRole('button',{name:'Add Private Remark',exact:true}).click();await dialog.getByRole('textbox',{name:'Private Remarks',exact:true}).fill('Unsaved private draft survives closing the workspace.');
   if(width===1440){
    const box=await dialog.boundingBox();
    await page.mouse.move(box.x+40,box.y+30);await page.mouse.down();await page.mouse.move(2,2);await page.mouse.up();await expect(dialog).toBeVisible();
    await page.mouse.click(2,2);await expect(dialog).not.toBeVisible();
    await nav.getByRole('button',{name:'Buyer Profile',exact:true}).click();await expect(dialog.getByRole('textbox',{name:'Private Remarks',exact:true})).toHaveValue('Unsaved private draft survives closing the workspace.');
   }
   await dialog.getByRole('region',{name:'Private Remarks',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
   await dialog.locator('.window-content').evaluate(e=>e.scrollTop=0);
   await page.screenshot({path:`artifacts/buyer-profile/compact-${width}.png`});
   assert.deepEqual(errors,[]);console.log(`PASS ${width}: footer themes, workspace retention, outside click guard`);
  }finally{await context.close();}
 }
}finally{await browser.close();}
