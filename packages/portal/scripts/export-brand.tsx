/** Regenerate static brand assets from the same artwork used by the portal. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { DogFace } from '../src/mascot';

const output = new URL('../public/', import.meta.url);
const face = renderToStaticMarkup(<DogFace />);
const mascot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" role="img" aria-label="Dogfood dog wearing sunglasses">${face}</svg>\n`;
await writeFile(new URL('dogfood.svg', output), mascot);
const font = await readFile(
  new URL(
    '../../../node_modules/@fontsource/nunito-sans/files/nunito-sans-latin-900-normal.woff2',
    import.meta.url,
  ),
);
for (const [variant, color] of [
  ['', '#18243B'],
  ['-light', '#FFFFFF'],
]) {
  const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 128" role="img" aria-label="Dogfood"><style>@font-face{font-family:Dogfood;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2');font-weight:900}</style>${face}<text x="142" y="87" fill="${color}" font-family="Dogfood,sans-serif" font-weight="900" font-size="76" letter-spacing="-4">dogfood</text></svg>\n`;
  await writeFile(new URL(`dogfood-wordmark${variant}.svg`, output), wordmark);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${mascot}`,
    );
    await page.screenshot({
      path: new URL(`dogfood-${size}.png`, output).pathname,
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}
