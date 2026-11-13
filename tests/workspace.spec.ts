import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function planPoint(page:Page,x:number,y:number) {
  const paper=page.getByTestId('paper');
  await expect(paper).toHaveAttribute('data-ready','true');
  const box=await paper.boundingBox();
  if (!box) throw new Error('Plan canvas has no position');
  return {x:box.x+x*box.width/780,y:box.y+y*box.width/780};
}
async function clickPlan(page:Page,x:number,y:number) {
  const p=await planPoint(page,x,y);
  await page.mouse.click(p.x,p.y);
}

test('local upload, live overlays, resize, approve, price, export and reopen',async({page})=>{
  const exceptions:string[]=[];
  const external:string[]=[];
  page.on('pageerror',e=>exceptions.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:8765') && !r.url().startsWith('blob:'))external.push(r.url());});
  await page.goto('/');
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'Upload PDF'}).click();
  await (await chooser).setFiles('samples/interior-demo.pdf');
  await expect(page.getByRole('navigation',{name:'Sheets'}).getByRole('button')).toHaveCount(4);
  await expect(page.getByTestId('paper')).toHaveAttribute('data-ready','true');

  await page.evaluate(()=>{
    const rows=document.querySelector('.measurements')!;
    const observer=new MutationObserver(()=>{
      const n=rows.querySelectorAll('button').length;
      if (n>0 && n<8) rows.setAttribute('data-saw-partial','true');
    });
    observer.observe(rows,{childList:true});
  });
  await page.getByRole('button',{name:'Run sheet takeoff'}).click();
  await expect(page.locator('.measurements button')).toHaveCount(8);
  await expect(page.getByRole('status')).toHaveText('8 added for review.');
  await expect(page.getByText('8 in review')).toBeVisible();
  await expect(page.locator('.measurements')).toHaveAttribute('data-saw-partial','true');
  await page.getByRole('button',{name:/Interior walls review.*12 LF/}).click();
  await expect(page.getByText('Selected measurement')).toBeVisible();
  const handle=await planPoint(page,204,205), moved=await planPoint(page,228,205);
  await page.mouse.move(handle.x,handle.y);await page.mouse.down();
  await page.mouse.move(moved.x,moved.y,{steps:8});await page.mouse.up();
  await expect(page.getByRole('button',{name:/Interior walls review.*edited 13\.67 LF/})).toBeVisible();

  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByRole('button',{name:/Interior walls review.*12 LF/})).toBeVisible();
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(page.getByRole('button',{name:/Interior walls review.*edited 13\.67 LF/})).toBeVisible();
  await page.getByRole('button',{name:/Interior walls review.*edited 13\.67 LF/}).click();
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByText('1 approved',{exact:true})).toBeVisible();
  await expect(page.locator('.bid')).toContainText('$5,635.00');
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download STACK CSV'}).click();
  const dl=await downloadEvent;
  expect(readFileSync((await dl.path())!,'utf8')).toMatch(/,13\.66\d+,Ln Ft/);
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Saved revision 1.');
  await page.reload();
  await page.getByRole('combobox',{name:'Open saved project'}).selectOption({label:'interior-demo.pdf'});
  await expect(page.getByText('1 approved',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Interior walls approved.*edited 13\.67 LF/})).toBeVisible();

  await page.getByRole('button',{name:/Sheet 2/}).click();
  await expect(page.getByTestId('paper')).toHaveAttribute('data-ready','true');
  await page.getByRole('button',{name:'Run sheet takeoff'}).click();
  await expect(page.getByRole('button',{name:/Interior walls review.*8 LF/})).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('1 added for review.');
  await page.getByRole('button',{name:/Sheet 3/}).click();
  await page.getByRole('button',{name:'Run sheet takeoff'}).click();
  await expect(page.getByText(/Raster (sheet: OpenCV found|backdrop detected)/)).toBeVisible();
  await expect(page.locator('.measurements button')).toHaveCount(0);

  await page.getByRole('button',{name:'Calibrate',exact:true}).click();
  await clickPlan(page,45,80);
  await clickPlan(page,165,80);
  await page.getByLabel('Known distance (ft)').fill('10');
  await page.getByRole('button',{name:'Apply scale'}).click();
  await page.getByRole('button',{name:/Flooring SF/}).click();
  await page.getByRole('button',{name:'Rectangle',exact:true}).click();
  await clickPlan(page,60,150);
  await clickPlan(page,180,246);
  const floor=page.getByRole('button',{name:/Flooring review.*manual.*SF/});
  await expect(floor).toBeVisible();
  const area=Number((await floor.locator('b').innerText()).split(' ')[0]);
  expect(area).toBeGreaterThan(78);
  expect(area).toBeLessThan(82);
  await page.getByLabel('Assigned scope').selectOption('slab');
  await page.getByLabel('Slab thickness (in)').fill('6');
  await expect(page.locator('.selection')).toContainText(/1\.4[5-9] CY|1\.5[01] CY/);
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.locator('.measurements button')).toHaveCount(0);
  expect(exceptions).toEqual([]);
  expect(external).toEqual([]);
});

test('draw remaining tools and move a count on the original plan',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Open sample'}).click();
  await expect(page.getByTestId('paper')).toHaveAttribute('data-ready','true');
  await page.getByRole('checkbox',{name:'Snap',exact:true}).uncheck();
  await page.getByRole('button',{name:'Calibrate',exact:true}).click();
  await clickPlan(page,42,401);
  await clickPlan(page,162,401);
  await page.getByLabel('Known distance (ft)').fill('10');
  await page.getByRole('button',{name:'Apply scale'}).click();

  await page.getByRole('button',{name:'Line',exact:true}).click();
  await clickPlan(page,90,325);
  await clickPlan(page,210,325);
  await page.getByRole('button',{name:'Polyline',exact:true}).click();
  await clickPlan(page,270,370);
  await clickPlan(page,390,370);
  await clickPlan(page,390,405);
  await page.getByRole('button',{name:'Finish trace'}).click();
  await expect(page.getByRole('button',{name:/Interior walls review.*manual.*LF/})).toHaveCount(2);

  await page.getByRole('button',{name:/Flooring SF/}).click();
  await page.getByRole('button',{name:'Polygon',exact:true}).click();
  await clickPlan(page,560,315);
  await clickPlan(page,680,315);
  await clickPlan(page,640,405);
  await page.getByRole('button',{name:'Finish trace'}).click();
  await expect(page.getByRole('button',{name:/Flooring review.*manual.*SF/})).toBeVisible();

  await page.getByRole('button',{name:/Doors EA/}).click();
  await page.getByRole('button',{name:'Count',exact:true}).click();
  await clickPlan(page,205,275);
  const count=page.getByRole('button',{name:/Doors review.*manual.*1 EA/});
  await count.click();
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  const start=await planPoint(page,205,275), end=await planPoint(page,250,275);
  // The outer edge of a count moves the body. The center handle edits its vertex.
  await page.mouse.move(start.x+7,start.y);await page.mouse.down();
  await page.mouse.move(end.x+7,end.y,{steps:8});await page.mouse.up();
  await expect(page.getByRole('button',{name:/Doors review.*edited.*1 EA/})).toBeVisible();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Saved revision 1.');
  const id=await page.getByRole('combobox',{name:'Open saved project'}).inputValue();
  const result=await page.evaluate(async id=>{
    if (!document.documentElement.dataset.hosted) return (await fetch('/api/projects/'+id)).json();
    return new Promise<any>((resolve,reject)=>{
      const db=indexedDB.open('a2z-takeoff-sandbox');
      db.onerror=()=>reject(db.error);
      db.onsuccess=()=>{
        const request=db.result.transaction('projects').objectStore('projects').get(id);
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{resolve({state:request.result.revisions.at(-1)});db.result.close();};
      };
    });
  },id);
  const x=result.state.items.find((item:{scope:string})=>item.scope==='door').points[0][0];
  expect(x).toBeGreaterThan(249);
  expect(x).toBeLessThan(251);
});
