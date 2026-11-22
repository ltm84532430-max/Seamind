const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(path.join(process.env.APPDATA, 'npm/node_modules/playwright'));

const screens = ['knowledge-home', 'knowledge-document', 'mindmap-overview', 'mindmap-edit'];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  for (const screen of screens) {
    const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${pathToFileURL(path.join(__dirname, 'index.html')).href}?screen=${screen}`);
    await page.screenshot({ path: path.join(__dirname, `${screen}.png`) });
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      width: innerWidth,
      appHeight: document.querySelector('.app')?.getBoundingClientRect().height,
      title: document.title,
    }));
    console.log(screen, JSON.stringify({ ...dims, errors }));
    await page.close();
  }
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
