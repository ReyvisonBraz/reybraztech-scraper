import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const packageJson = JSON.parse(
  await readFile(new URL('../node_modules/@playwright/test/package.json', import.meta.url), 'utf8'),
);
const expected = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'));
const browser = await chromium.launch();

try {
  const actual = {
    node: process.versions.node,
    playwright: packageJson.version,
    chromium: browser.version(),
  };

  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(actual));
    process.exitCode = 0;
  } else {
    const mismatches = Object.keys(actual).filter((key) => actual[key] !== expected[key]);
    if (mismatches.length > 0) {
      console.error(
        JSON.stringify({
          status: 'version_mismatch',
          mismatches,
          expected,
          actual,
        }),
      );
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ status: 'versions_verified', ...actual }));
    }
  }
} finally {
  await browser.close();
}
