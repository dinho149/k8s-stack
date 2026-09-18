// Rasterize the existing repository SVG for the macOS bundle icon.
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });
  const svg = await readFile('../portal/public/dogfood.svg', 'utf8');
  await page.setContent(
    `<style>html,body{margin:0;width:1024px;height:1024px;background:transparent}svg{width:100%;height:100%}</style>${svg}`,
  );
  await mkdir('build', { recursive: true });
  await page.screenshot({ path: 'build/icon.png', omitBackground: true });
} finally {
  await browser.close();
}
