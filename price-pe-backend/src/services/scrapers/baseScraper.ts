import fs from 'fs';
import path from 'path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from 'playwright';
import env from '../../config/env';
import logger from '../../config/logger';
import { delay } from '../../utils/scraperHelpers';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Shared Playwright lifecycle for platform scrapers (Zomato, Swiggy, …).
 */
export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected platformName: string;
  public isConnected = false;
  public lastError: string | null = null;

  constructor(platformName: string) {
    this.platformName = platformName;
  }

  async initialize(): Promise<void> {
    if (this.isConnected && this.browser && this.page) {
      logger.warn(`[${this.platformName}] Scraper already initialized`);
      return;
    }

    logger.info(`[${this.platformName}] Launching Chromium`, {
      headless: env.scrapper.headless,
    });

    try {
      // Prefer system Chrome when available (often less blocked than bundled Chromium)
      try {
        this.browser = await chromium.launch({
          channel: 'chrome',
          headless: env.scrapper.headless,
          args: this.launchArgs(),
        });
        logger.info(`[${this.platformName}] Using system Chrome channel`);
      } catch {
        this.browser = await chromium.launch({
          headless: env.scrapper.headless,
          args: this.launchArgs(),
        });
        logger.info(`[${this.platformName}] Using bundled Chromium`);
      }

      this.context = await this.browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1366, height: 768 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        extraHTTPHeaders: {
          'Accept-Language': 'en-IN,en;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        },
      });

      // Speed up loads — keep images (needed for card thumbnails), drop heavy media/fonts
      await this.context.route('**/*', async (route) => {
        const type = route.request().resourceType();
        if (['media', 'font'].includes(type)) {
          await route.abort();
          return;
        }
        await route.continue();
      });

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(60_000);
      this.page.setDefaultNavigationTimeout(90_000);
      await this.setupStealth();

      this.isConnected = true;
      this.lastError = null;
      logger.info(`[${this.platformName}] Browser ready`);
    } catch (error) {
      await this.close();
      const err = error as Error;
      this.lastError = err.message;
      logger.error(`[${this.platformName}] Failed to initialize browser`, {
        error: err.message,
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    logger.info(`[${this.platformName}] Closing browser`);

    try {
      await this.page?.close().catch(() => undefined);
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
      this.isConnected = false;
      logger.info(`[${this.platformName}] Browser closed`);
    }
  }

  /**
   * Light stealth patches — not a full anti-bot suite, but reduces trivial bot signals.
   */
  async setupStealth(): Promise<void> {
    if (!this.page) {
      return;
    }

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-IN', 'en', 'hi'],
      });

      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      const win = window as Window & { chrome?: { runtime: Record<string, unknown> } };
      win.chrome = { runtime: {} };
    });

    logger.debug(`[${this.platformName}] Stealth hooks applied`);
  }

  async takeScreenshot(name: string): Promise<void> {
    if (!this.page) {
      return;
    }

    const dir = path.join(process.cwd(), 'logs', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${name}-${Date.now()}.png`);

    try {
      await this.page.screenshot({
        path: filePath,
        fullPage: false,
        timeout: 10_000,
        animations: 'disabled',
      });
      logger.info(`[${this.platformName}] Screenshot saved`, { filePath });
    } catch (error) {
      logger.warn(`[${this.platformName}] Failed to save screenshot`, {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Navigate with retries. Uses `commit` first (earliest reliable signal), then
   * optionally waits for DOM if the document becomes available.
   */
  protected async gotoWithRetry(
    url: string,
    options?: { timeoutMs?: number; retries?: number }
  ): Promise<Response | null> {
    const page = this.ensurePage();
    const retries = options?.retries ?? env.scrapper.maxRetries;
    const timeout = options?.timeoutMs ?? 90_000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        logger.debug(`[${this.platformName}] Navigating`, { url, attempt, retries });

        const response = await page.goto(url, {
          waitUntil: 'commit',
          timeout,
        });

        // Best-effort DOM readiness — do not fail the whole navigation on this
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {
          logger.debug(`[${this.platformName}] domcontentloaded wait skipped`);
        });

        this.lastError = null;
        return response;
      } catch (error) {
        lastError = error as Error;
        this.lastError = lastError.message;
        logger.warn(`[${this.platformName}] Navigation attempt failed`, {
          url,
          attempt,
          error: lastError.message,
        });

        if (attempt < retries) {
          await delay(1_000 * attempt);
        }
      }
    }

    throw lastError ?? new Error(`Failed to navigate to ${url}`);
  }

  protected ensurePage(): Page {
    if (!this.isConnected || !this.page) {
      throw new Error(
        `${this.platformName} scraper is not connected. Call initialize() first.`
      );
    }
    return this.page;
  }

  /**
   * Detect common block / CAPTCHA surfaces. Best-effort — Zomato markup changes often.
   */
  protected async detectBlockOrCaptcha(): Promise<string | null> {
    const page = this.ensurePage();

    try {
      const title = (await page.title()).toLowerCase();
      const snippet = await page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .catch(() => '');
      const content = snippet.toLowerCase().slice(0, 4000);

      if (
        content.includes('captcha') ||
        content.includes('access denied') ||
        content.includes('unusual traffic') ||
        title.includes('captcha') ||
        title.includes('access denied')
      ) {
        return 'Possible CAPTCHA or access block detected on Zomato';
      }
    } catch {
      // Ignore detection failures on half-loaded pages
    }

    return null;
  }

  private launchArgs(): string[] {
    return [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-http2',
      '--disable-dev-shm-usage',
      '--disable-extensions',
    ];
  }

  abstract search(query: string, location: string): Promise<unknown>;
  abstract getItemDetails(itemId: string): Promise<unknown>;
}

export default BaseScraper;
