const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const os = require('node:os');

const origin = 'https://bsthantietnieu.com';
const pages = [
  '/', '/tan-soi/', '/tuyen-tien-liet/', '/cat-bao-quy-dau/',
  '/suc-khoe-tinh-duc-nam/', '/tieu-gap-son-tieu/', '/dat-lich/',
  '/gap-bac-si/', '/chinh-sach-bao-mat/',
];
const result = [];
const viewports = [320, 390, 768, 1280, 1920];
const out = 'evidence';
mkdirSync(out, { recursive: true });

async function layout(page) {
  return page.evaluate(() => {
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const selectors = 'h1,h2,.story,#leadForm .l,#leadForm .ck span,#leadForm input,#leadForm select,#leadForm textarea,#submitBtn';
    const defects = [];
    const headings = [];
    for (const el of [...document.querySelectorAll(selectors)].filter(visible)) {
      const box = el.getBoundingClientRect();
      const rows = new Map();
      let latin = '';
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) {
        latin += n.data;
        const re = /\S+/g;
        for (let m; (m = re.exec(n.data));) {
          if (n.parentElement.closest('select')) continue;
          const range = document.createRange();
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          for (const rect of range.getClientRects()) {
            const y = Math.round(rect.top);
            if (!rows.has(y)) rows.set(y, []);
            rows.get(y).push(m[0]);
            if (rect.left < box.left-2 || rect.right > box.right+2) {
              defects.push(['text out of bounds', el.tagName, m[0], el.textContent.trim()]);
            }
          }
        }
      }
      if (latin.includes('\uFFFD')) defects.push(['invalid Unicode', latin]);
      if (box.right > innerWidth+1 && box.width > 0) defects.push(['element overflowing', el.id||el.className]);
      if (el.tagName === 'H1' || el.matches('#tam-ly-hay-co-the h2, #dat-lich h2')) {
        headings.push([...rows.values()].map(row=>row.join(' ')));
      }
    }
    const fields = [...document.querySelectorAll('#leadForm input[type=text],#leadForm input[type=tel],#leadForm select,#leadForm textarea')]
      .filter(visible).map(el => {
        const style = getComputedStyle(el);
        return [el.id, style.backgroundColor, style.color, style.fontFamily];
      });
    const selectLabels = [...document.querySelectorAll('#leadForm select')].filter(visible).map(el => {
      const style = getComputedStyle(el);
      const canvas = document.createElement('canvas').getContext('2d');
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available=el.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-12;
      return {
        id:el.id,
        clipped:[...el.options].filter(o=>!o.hidden && !o.disabled && canvas.measureText(o.text).width>available).map(o=>o.text),
      };
    }).filter(x=>x.clipped.length);
    return {
      layout:[document.documentElement.scrollWidth,innerWidth], defects, headings, fields, selectLabels,
      body:getComputedStyle(document.body).backgroundColor,
      scheme:getComputedStyle(document.documentElement).colorScheme,
      dark:matchMedia('(prefers-color-scheme: dark)').matches,
      h1:document.querySelector('h1')?.textContent.trim(),
    };
  });
}

async function auditForm(page) {
  const form = page.locator('#leadForm');
  if (!(await form.count())) return false;
  await form.waitFor({ state: 'visible', timeout: 12000 });
  await page.locator('#visit_intent').selectOption('book');
  await page.locator('#need').selectOption('tuyen-tien-liet');
  await page.locator('#full_name').fill('Kiểm thử tiếng Việt');
  await page.locator('#phone').fill('0900000000');
  await page.locator('#has_results').check();
  await page.locator('#age_confirmed_18').check();
  await page.locator('#consent_contact').check();
  assert.ok(await page.locator('#submitBtn').isEnabled());
  return true;
}

async function fonts(session, selector) {
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return [];
  const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts;
}

async function main() {
  const onWindows = process.platform === 'win32';
  if (process.env.GITHUB_ACTIONS) assert.ok(onWindows);
  console.log('Platform:', process.platform, os.release(), process.arch);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  console.log('Google Chrome:', browser.version());
  try {
    for (const width of viewports) {
      const context = await browser.newContext({ viewport: { width, height: 950 }, locale: 'vi-VN', reducedMotion: 'reduce' });
      await context.route('**/*', route => {
        const req = route.request();
        return req.method() === 'GET' && new URL(req.url()).origin === origin ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await session.send('DOM.enable');
      await session.send('CSS.enable');
      for (const path of pages) {
        const row = { path, width, errors: [] };
        result.push(row);
        try {
          await page.emulateMedia({ colorScheme: 'light' });
          await session.send('Emulation.setAutoDarkModeOverride', { enabled: false });
          const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
          assert.ok(response.ok(), `HTTP ${response.status()}`);
          await page.waitForSelector('body[data-public="1"]', { state: 'attached', timeout: 12000 });
          await page.evaluate(()=>document.fonts.ready);
          row.form = await auditForm(page);
          row.light = await layout(page);
          assert.ok(row.light.h1);
          assert.equal(row.light.body, 'rgb(255, 255, 255)');
          assert.equal(row.light.dark, false);
          row.fonts = {
            heading: await fonts(session, 'h1'),
            body: await fonts(session, '.story, .policy p'),
            label: row.form ? await fonts(session, '#leadForm label.l') : [],
          };
          if (onWindows) {
            assert.ok(row.fonts.heading.length && row.fonts.heading.every(f => f.familyName === 'Arial'), JSON.stringify(row.fonts.heading));
            assert.ok(row.fonts.body.length && row.fonts.body.every(f => f.familyName === 'Source Serif 4' && f.isCustomFont), JSON.stringify(row.fonts.body));
            if (row.form) {
              assert.ok(row.fonts.label.length && row.fonts.label.every(f => f.familyName === 'Arial'), JSON.stringify(row.fonts.label));
            }
          }
          await page.emulateMedia({ colorScheme: 'dark' });
          await session.send('Emulation.setAutoDarkModeOverride', { enabled: true });
          row.dark = await layout(page);
          assert.equal(row.dark.dark, true);
          assert.equal(row.dark.body, 'rgb(255, 255, 255)');
          assert.deepEqual(row.dark.headings, row.light.headings);
          assert.deepEqual(row.dark.layout, [width, width]);
          assert.deepEqual(row.dark.defects, []);
          for (const [id, background, color] of row.dark.fields) {
            assert.equal(background, 'rgb(255, 255, 255)', id);
            assert.equal(color, 'rgb(0, 0, 0)', id);
          }
          const key = path === '/' ? 'home' : path.slice(1,-1);
          if (width===390 || width===1280) {
            await page.evaluate(() => window.scrollTo(0,0));
            const png = await page.screenshot({ path: `${out}/${key}-${width}-dark.png` });
            assert.deepEqual([...PNG.sync.read(png).data.subarray(0,4)], [255,255,255,255]);
            if (key === 'dat-lich') {
              await page.locator('#leadForm').scrollIntoViewIfNeeded();
              await page.screenshot({ path: `${out}/booking-${width}-dark.png` });
            }
          }
          console.log('PASS', width, path, JSON.stringify(row.dark.headings));
        } catch (error) {
          row.errors.push(error.message);
          console.log('FAIL', width, path, error.message);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    writeFileSync(`${out}/report.json`, JSON.stringify(result, null, 2));
  }
  const failed = result.filter(row=>row.errors.length);
  console.log(`${result.length-failed.length}/${result.length} configurations passed`);
  if(failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
