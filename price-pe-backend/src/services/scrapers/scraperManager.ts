import logger from '../../config/logger';
import { SwiggyScraper } from './swiggyScraper';
import { ZomatoScraper } from './zomatoScraper';

/**
 * Singleton manager for platform scrapers.
 */
class ScraperManager {
  readonly zomato: ZomatoScraper;
  readonly swiggy: SwiggyScraper;
  private initialized = false;

  constructor() {
    this.zomato = new ZomatoScraper();
    this.swiggy = new SwiggyScraper();
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Best-effort browser boot. Failures are logged; HTTP API still starts.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing scrapers');

    await Promise.all([
      this.zomato
        .initialize()
        .then(() => logger.info('Zomato scraper initialized successfully'))
        .catch((error: Error) => {
          logger.warn(
            'Zomato scraper initialization failed — routes will return 503 until recovered',
            {
              error: error.message,
              hint: 'Ensure Playwright Chromium is installed: npx playwright install chromium',
            }
          );
        }),
      this.swiggy
        .initialize()
        .then(() => logger.info('Swiggy scraper initialized successfully'))
        .catch((error: Error) => {
          logger.warn(
            'Swiggy scraper initialization failed — routes will return 503 until recovered',
            {
              error: error.message,
              hint: 'Ensure Playwright Chromium is installed: npx playwright install chromium',
            }
          );
        }),
    ]);

    this.initialized = true;
    logger.info('Scraper manager ready', {
      zomatoConnected: this.zomato.isConnected,
      swiggyConnected: this.swiggy.isConnected,
    });
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down scrapers');

    await Promise.all([
      (async () => {
        try {
          if (this.zomato.isConnected) {
            await this.zomato.close();
          }
        } catch (error) {
          logger.warn('Error closing Zomato scraper', {
            error: (error as Error).message,
          });
        }
      })(),
      (async () => {
        try {
          if (this.swiggy.isConnected) {
            await this.swiggy.close();
          }
        } catch (error) {
          logger.warn('Error closing Swiggy scraper', {
            error: (error as Error).message,
          });
        }
      })(),
    ]);

    this.initialized = false;
    logger.info('Scrapers shut down');
  }
}

const scraperManager = new ScraperManager();
export default scraperManager;
