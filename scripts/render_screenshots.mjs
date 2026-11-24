import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const popupUrl = `file://${join(root, 'release', 'chrome-extension', 'popup.html')}`;

async function main() {
  const executablePath = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined;
  const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
  const context = await browser.newContext({
    viewport: { width: 380, height: 950 },
    deviceScaleFactor: 2,
  });

  await context.addInitScript(() => {
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: '1.0.0' }),
        sendMessage: async (msg) => {
          if (msg.type === 'status') {
            return {
              connected: true,
              bridgeUrl: 'https://bridge.example.workers.dev',
              tab: { id: 101, title: 'Chat Target' },
              sessionEpoch: 1,
              pages: {
                primary: {
                  online: true,
                  tabId: 101,
                  title: 'Primary Target Chat',
                  models: ['model-example', 'model-fast', 'model-reasoning', 'model-vision']
                },
                secondary: {
                  online: true,
                  tabId: 102,
                  title: 'Secondary Target Provider',
                  models: ['secondary-session-model']
                }
              }
            };
          }
          return null;
        }
      },
      storage: {
        local: {
          get: async () => ({
            bridgeUrl: 'https://bridge.example.workers.dev',
            bridgeToken: '',
            clientApiKey: '',
            defaultModel: 'model-example',
            userConfigured: true
          }),
          set: async () => {}
        }
      }
    };

    const originalFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            connected: true,
            version: '1.0.0',
            models: [
              { id: 'model-example', name: 'Standard Example Model', provider: 'primary', free: true },
              { id: 'model-fast', name: 'Fast Example Model', provider: 'primary', free: true },
              { id: 'model-reasoning', name: 'Reasoning Model', provider: 'primary', free: false },
              { id: 'model-vision', name: 'Vision Model', provider: 'primary', free: false },
              { id: 'secondary-session-model', name: 'Secondary Model', provider: 'secondary', free: true }
            ],
            defaultModel: 'model-example',
            credits: { remaining: 100, total: 100 }
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
  });

  const page = await context.newPage();
  await page.goto(popupUrl);
  await page.waitForTimeout(600);

  // Screenshot 1: Connected normal view
  const normalPath = join(root, 'docs', 'assets', 'chrome-extension-popup.png');
  await page.screenshot({ path: normalPath, fullPage: true });
  console.log(`Saved: ${normalPath}`);

  // Screenshot 2: Open Advanced / Settings details
  const details = page.locator('details');
  if (await details.count()) {
    await details.first().evaluate((el) => { el.open = true; });
    await page.waitForTimeout(300);
  }
  const advancedPath = join(root, 'docs', 'assets', 'chrome-extension-popup-advanced.png');
  await page.screenshot({ path: advancedPath, fullPage: true });
  console.log(`Saved: ${advancedPath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
