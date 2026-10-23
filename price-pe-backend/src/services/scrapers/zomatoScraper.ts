import env from '../../config/env';
import logger from '../../config/logger';
import type {
  RestaurantMenuResult,
  SearchItemsResult,
  ZomatoMenuItem,
  ZomatoSearchItem,
} from '../../types/scraper';
import {
  cleanText,
  delay,
  extractDeliveryTime,
  extractPrice,
  extractRating,
} from '../../utils/scraperHelpers';
import { BaseScraper } from './baseScraper';

/**
 * Zomato public-page scraper.
 *
 * TODO: CSS / data-testid selectors below are best-effort and may break when
 * Zomato redesigns. Prefer resilient attribute/text patterns over deep class chains.
 */
export class ZomatoScraper extends BaseScraper {
  constructor() {
    super('zomato');
  }

  async initialize(): Promise<void> {
    // Browser launch alone marks connected. Homepage warm-up is best-effort —
    // Zomato often times out/blocks headless Chromium; that must not flip connected=false.
    await super.initialize();

    const city = this.normalizeLocation(env.scrapper.defaultLocation);
    const warmUrl = `https://www.zomato.com/${city}`;

    try {
      logger.info('[zomato] Warming up session (non-fatal)', { warmUrl });
      await this.gotoWithRetry(warmUrl, { timeoutMs: 60_000, retries: 2 });
      await this.handleLocationPopup();
      await delay(Math.min(env.scrapper.requestDelay, 1500));

      const blocked = await this.detectBlockOrCaptcha();
      if (blocked) {
        logger.warn('[zomato] Warm-up may be blocked', { blocked });
        await this.takeScreenshot('zomato-init-blocked');
        this.lastError = blocked;
      } else {
        logger.info('[zomato] Warm-up navigation succeeded');
      }
    } catch (error) {
      // Keep browser open so /status shows connected:true and routes can retry later
      this.lastError = (error as Error).message;
      logger.warn('[zomato] Warm-up navigation failed — browser stays ready for scrape retries', {
        error: this.lastError,
      });
      await this.takeScreenshot('zomato-init-warmup-failed');
    }
  }

  /**
   * Dish search via Zomato delivery dish pages, e.g.
   * https://www.zomato.com/bangalore/delivery/dish-biryani
   * https://www.zomato.com/ncr/delivery/dish-pizza  (Noida / Delhi NCR)
   */
  async searchItems(query: string, location: string): Promise<SearchItemsResult> {
    const PLACEHOLDER = 'https://via.placeholder.com/150?text=No+Image';

    try {
      const page = this.ensurePage();
      const { citySlug: city, placeHint } = this.resolveZomatoCity(location);
      const dishSlug = query.toLowerCase().trim().replace(/\s+/g, '-');
      const url = `https://www.zomato.com/${city}/delivery/dish-${dishSlug}`;

      logger.info('[zomato] Dish search', {
        query,
        dishSlug,
        inputLocation: location,
        citySlug: city,
        placeHint,
        url,
      });
      await delay(Math.min(env.scrapper.requestDelay, 1000));

      await this.gotoWithRetry(url, { timeoutMs: 75_000, retries: 2 });

      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {
        logger.debug('[zomato] domcontentloaded wait skipped');
      });

      // Best-effort: pin sub-area after landing (e.g. "Sector 20, Noida")
      if (placeHint && !/^(noida|ncr|delhi|gurgaon|gurugram|bangalore|bengaluru|mumbai|pune|hyderabad|chennai|kolkata)$/i.test(placeHint)) {
        await this.applyPlaceHint(placeHint);
      }

      const blocked = await this.detectBlockOrCaptcha();
      if (blocked) {
        await this.takeScreenshot('zomato-dish-search-blocked');
        return { success: false, data: [], error: blocked };
      }

      // TODO: dish cards often live in jumbo-tracker / menu-item style containers
      await page
        .waitForSelector(
          [
            'div.jumbo-tracker',
            '[class*="jumbo-tracker"]',
            'a[href*="/order"]',
            '[data-testid*="menu"]',
          ].join(', '),
          { timeout: 25_000 }
        )
        .catch(() => {
          logger.warn('[zomato] Dish card selector not found quickly');
        });

      // Lazy-load images + dynamic dish cards
      await page.evaluate(() => window.scrollBy(0, 500));
      await delay(1500);
      await page.evaluate(() => window.scrollBy(0, 500));
      await delay(1000);

      const rawCards = await page.evaluate(
        ({ citySlug, dishQuery }: { citySlug: string; dishQuery: string }) => {
          const results: Array<{
            dish_name: string;
            restaurant_name: string;
            restaurant_url: string;
            price_text: string;
            rating_text: string;
            delivery_text: string;
            image_url: string;
            is_veg: boolean;
            deep_link: string;
          }> = [];

          const titleCaseDish = (q: string): string =>
            q
              .split(/[\s-]+/)
              .filter(Boolean)
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
              .join(' ');

          const defaultDishName = titleCaseDish(dishQuery);

          const slugify = (value: string): string =>
            value
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');

          const toAbsolute = (href: string): string => {
            if (!href) return '';
            if (href.startsWith('http')) return href.split('?')[0];
            return `https://www.zomato.com${href.startsWith('/') ? '' : '/'}${href}`.split(
              '?'
            )[0];
          };

          const restaurantIdFromUrl = (url: string): string => {
            try {
              const parts = new URL(url).pathname.split('/').filter(Boolean);
              return parts[1] || '';
            } catch {
              return '';
            }
          };

          const isRestaurantHref = (href: string): boolean => {
            if (!href) return false;
            const path = href.replace(/^https?:\/\/(www\.)?zomato\.com/i, '').split('?')[0];
            if (/\/delivery\/dish-/i.test(path)) return false;
            if (/\/collections?/i.test(path)) return false;
            const re = new RegExp(
              `^\\/${citySlug}\\/(?!delivery$|restaurants$|order-food$)([a-z0-9][a-z0-9-]{2,})(\\/(order|info))?\\/?$`,
              'i'
            );
            return re.test(path);
          };

          const pickImage = (root: HTMLElement): string => {
            const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
            const candidates: string[] = [];
            for (const img of imgs) {
              const attrs = [
                img.currentSrc,
                img.src,
                img.getAttribute('data-src'),
                img.getAttribute('data-original'),
                ...(img.getAttribute('srcset') || '')
                  .split(',')
                  .map((p) => p.trim().split(/\s+/)[0]),
              ];
              for (const src of attrs) {
                if (
                  src &&
                  /zmtcdn\.com|b\.zmtcdn\.com|cloudinary/i.test(src) &&
                  !/placeholder/i.test(src) &&
                  !src.startsWith('data:')
                ) {
                  candidates.push(src);
                }
              }
            }
            // Prefer dish photos over restaurant featured images
            return (
              candidates.find((c) => /dish_photos/i.test(c)) ||
              candidates[0] ||
              ''
            );
          };

          const detectVeg = (root: HTMLElement): boolean => {
            const html = root.innerHTML.toLowerCase();
            const aria = (root.getAttribute('aria-label') || '').toLowerCase();
            const blob = `${html} ${aria}`;
            if (blob.includes('non-veg') || blob.includes('nonveg') || blob.includes('non veg')) {
              return false;
            }
            if (
              blob.includes('type="veg"') ||
              blob.includes('veg-icon') ||
              blob.includes('is-veg') ||
              /\bveg\b/.test(aria)
            ) {
              return true;
            }
            const marker = root.querySelector(
              'img[src*="veg"], img[alt*="veg" i], [class*="veg"], [type="veg"]'
            );
            if (marker) {
              const alt = (marker.getAttribute('alt') || marker.className || '').toLowerCase();
              return !alt.includes('non');
            }
            return false;
          };

          const looksLikeRestaurantTitle = (title: string, restaurantUrl: string): boolean => {
            const id = restaurantIdFromUrl(restaurantUrl);
            const titleSlug = slugify(title);
            if (!id || !titleSlug) return false;
            // "Biryani Blues" ↔ biryani-blues-church-street-bangalore
            return id.includes(titleSlug) || titleSlug.includes(id.split('-').slice(0, 3).join('-'));
          };

          /** Cuisine chips look like: "North Indian, Biryani, Chinese" */
          const isCuisineLine = (line: string): boolean => {
            if (!line) return false;
            const lower = line.toLowerCase();
            const cuisineHints =
              /(north indian|south indian|chinese|mughlai|arabic|kebab|biryani|rolls|desserts|beverages|fast food|street food|sandwich|afghani|seafood|pizza|burger|thai|continental)/i;
            const commaCount = (line.match(/,/g) || []).length;
            if (commaCount >= 1 && cuisineHints.test(lower)) return true;
            if (commaCount >= 2) return true;
            return false;
          };

          const parseCardLines = (text: string) => {
            const lines = text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);

            let idx = 0;
            while (
              idx < lines.length &&
              (/^\d+%\s*off/i.test(lines[idx]) ||
                /pro extra/i.test(lines[idx]) ||
                /must try/i.test(lines[idx]) ||
                /bestsellers?/i.test(lines[idx]) ||
                /ad$/i.test(lines[idx]))
            ) {
              idx += 1;
            }

            const primary = lines[idx] || '';
            const rest = lines.slice(idx + 1);

            // Skip cuisine lines when picking a secondary "name" candidate
            const secondary =
              rest.find(
                (l) =>
                  l.length > 2 &&
                  !isCuisineLine(l) &&
                  !/₹|rs\.?/i.test(l) &&
                  !/^\d+(\.\d+)?$/.test(l) &&
                  !/\d+\s*(-|–|to)?\s*\d*\s*min/i.test(l) &&
                  !/%\s*off/i.test(l) &&
                  !/^\d+\s*ratings?/i.test(l)
              ) || '';

            const cuisine_text = rest.find((l) => isCuisineLine(l)) || '';

            const rating_text =
              rest.find((l) => /^\d(?:\.\d)?$/.test(l) || /^\d(?:\.\d)?\s*★/.test(l)) || '';
            const price_text = rest.find((l) => /₹|rs\.?/i.test(l)) || '';
            const delivery_text =
              rest.find((l) => /\d+\s*(-|–|to)?\s*\d*\s*min/i.test(l)) || '';

            return {
              primary,
              secondary,
              cuisine_text,
              rating_text,
              price_text,
              delivery_text,
            };
          };

          const trackers = Array.from(
            document.querySelectorAll(
              [
                'div.jumbo-tracker',
                '[class*="jumbo-tracker"]',
                '[data-testid*="menu-item"]',
                '[class*="menu-item"]',
              ].join(', ')
            )
          ) as HTMLElement[];

          const seen = new Set<string>();

          const pushCard = (root: HTMLElement) => {
            const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
            const orderLink =
              anchors.find((a) => isRestaurantHref(a.getAttribute('href') || '')) || null;

            const href = orderLink?.getAttribute('href') || '';
            const restaurant_url = toAbsolute(href);
            if (!restaurant_url) return;

            const headings = Array.from(root.querySelectorAll('h4, h3, h2'))
              .map((h) => (h.textContent || '').trim())
              .filter((h) => h && !isCuisineLine(h));
            const parsed = parseCardLines(root.innerText || '');
            const primary = headings[0] || (isCuisineLine(parsed.primary) ? '' : parsed.primary);
            const image_url = pickImage(root);

            // On /delivery/dish-* pages, cards are restaurants that serve the dish.
            // The comma line under the title is cuisine tags — NOT the dish name.
            let restaurant_name = '';
            if (primary && looksLikeRestaurantTitle(primary, restaurant_url)) {
              restaurant_name = primary;
            } else if (primary && !isCuisineLine(primary)) {
              restaurant_name = primary;
            } else {
              // Last resort: humanize slug from URL
              restaurant_name = restaurantIdFromUrl(restaurant_url)
                .replace(/-/g, ' ')
                .replace(/\b\w/g, (c) => c.toUpperCase());
            }

            // Dish name = search query (e.g. "Biryani"). Do not use cuisine chips.
            const dish_name = defaultDishName;

            restaurant_name = (restaurant_name || '').trim();
            if (!restaurant_name || restaurant_name.length < 2) return;
            if (isCuisineLine(restaurant_name)) return;

            const deep_link = restaurant_url;
            // One row per restaurant on a dish page
            const key = restaurant_url;
            if (seen.has(key)) return;
            seen.add(key);

            results.push({
              dish_name,
              restaurant_name,
              restaurant_url,
              price_text: parsed.price_text,
              rating_text: parsed.rating_text,
              delivery_text: parsed.delivery_text,
              image_url,
              is_veg: detectVeg(root),
              deep_link,
            });
          };

          for (const tracker of trackers) {
            pushCard(tracker);
            if (results.length >= 50) break;
          }

          if (results.length === 0) {
            const orderAnchors = Array.from(
              document.querySelectorAll('a[href*="/order"]')
            ) as HTMLAnchorElement[];
            for (const a of orderAnchors) {
              if (!isRestaurantHref(a.getAttribute('href') || '')) continue;
              const root = (a.closest(
                'div.jumbo-tracker, [class*="jumbo-tracker"], article, section, div'
              ) || a.parentElement) as HTMLElement | null;
              if (root) pushCard(root);
              if (results.length >= 50) break;
            }
          }

          return results;
        },
        { citySlug: city, dishQuery: query }
      );

      const dishLabel = query
        .split(/[\s-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');

      const isCuisineName = (value: string): boolean => {
        const commaCount = (value.match(/,/g) || []).length;
        return (
          commaCount >= 1 &&
          /(north indian|south indian|chinese|mughlai|kebab|biryani|rolls|desserts)/i.test(
            value
          )
        );
      };

      const data: ZomatoSearchItem[] = [];
      for (const card of rawCards) {
        if (!this.isRestaurantUrl(card.restaurant_url, city)) {
          continue;
        }

        let restaurant_name = cleanText(card.restaurant_name);
        let dish_name = cleanText(card.dish_name) || dishLabel;

        // Fix swapped / cuisine-as-name cases
        if (isCuisineName(restaurant_name) && !isCuisineName(dish_name)) {
          restaurant_name = dish_name;
          dish_name = dishLabel;
        }
        if (isCuisineName(dish_name)) {
          dish_name = dishLabel;
        }
        if (!restaurant_name || isCuisineName(restaurant_name)) {
          continue;
        }

        // On dish pages every card is already filtered by Zomato for this dish.
        // Still drop obvious junk titles.
        if (restaurant_name.length < 2) {
          continue;
        }

        const restaurant_id = this.extractRestaurantId(card.restaurant_url);
        const image_url = this.sanitizeImageUrl(card.image_url) || PLACEHOLDER;

        data.push({
          dish_name,
          restaurant_name,
          restaurant_id,
          price: extractPrice(card.price_text),
          rating: extractRating(card.rating_text),
          delivery_time_min: extractDeliveryTime(card.delivery_text),
          image_url,
          is_veg: card.is_veg,
          deep_link: card.deep_link || card.restaurant_url,
        });
      }

      logger.info('[zomato] Dish search completed', {
        query,
        location: city,
        raw: rawCards.length,
        filtered: data.length,
        sample: data.slice(0, 8).map((d) => `${d.dish_name} @ ${d.restaurant_name}`),
      });

      return { success: true, data };
    } catch (error) {
      const message = (error as Error).message;
      await this.takeScreenshot('zomato-dish-search-error');
      logger.error('[zomato] searchItems (dish) failed', { error: message });
      return {
        success: false,
        data: [],
        error: message || 'Failed to scrape Zomato dish search results',
      };
    }
  }

  async getRestaurantMenu(restaurantUrl: string): Promise<RestaurantMenuResult> {
    try {
      const page = this.ensurePage();
      logger.info('[zomato] Fetching restaurant menu', { restaurantUrl });
      await delay(env.scrapper.requestDelay);

      await this.gotoWithRetry(restaurantUrl, { timeoutMs: 90_000 });

      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

      const blocked = await this.detectBlockOrCaptcha();
      if (blocked) {
        await this.takeScreenshot('zomato-menu-blocked');
        return { success: false, data: [], error: blocked };
      }

      // TODO: menu root selectors — update when DOM changes
      await page
        .waitForSelector(
          [
            '[data-testid="menu-item"]',
            'h4',
            'div[class*="menu"]',
            'section',
          ].join(', '),
          { timeout: 20_000 }
        )
        .catch(() => undefined);

      await this.scrollToLoadMenu();

      const rawItems = await page.evaluate(() => {
        const items: Array<{
          name: string;
          price_text: string;
          description: string;
          is_veg: boolean;
          image_url: string;
          category: string;
        }> = [];

        // TODO: Prefer [data-testid="menu-item"] when present
        const nodes = Array.from(
          document.querySelectorAll(
            [
              '[data-testid="menu-item"]',
              '[class*="menu-item"]',
              'div[class*="sc-"] h4',
            ].join(', ')
          )
        );

        let currentCategory = 'General';
        const categoryHeadings = Array.from(
          document.querySelectorAll('h2, h3, [class*="category"]')
        );

        for (const node of nodes) {
          const card =
            (node.closest('[data-testid="menu-item"]') as HTMLElement | null) ||
            (node.closest('div') as HTMLElement | null) ||
            (node as HTMLElement);

          const nameEl =
            card.querySelector('h4, h3, [class*="title"], [class*="name"]') || node;
          const name = (nameEl.textContent || '').trim();
          if (!name || name.length < 2) {
            continue;
          }

          // Infer category from nearest preceding heading
          for (const heading of categoryHeadings) {
            if (
              heading.compareDocumentPosition(card) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ) {
              const text = (heading.textContent || '').trim();
              if (text && text.length < 80) {
                currentCategory = text;
              }
            }
          }

          const priceCandidate = Array.from(card.querySelectorAll('span, p, div')).find(
            (el) => /₹|rs\.?/i.test(el.textContent || '')
          );
          const descEl = card.querySelector('p, [class*="desc"], [class*="subtitle"]');
          const img = card.querySelector('img') as HTMLImageElement | null;

          // Veg/non-veg markers often use green/red icons or aria labels
          const vegHint = (
            card.getAttribute('aria-label') ||
            card.innerHTML ||
            ''
          ).toLowerCase();
          const is_veg =
            vegHint.includes('veg') && !vegHint.includes('non-veg')
              ? true
              : vegHint.includes('non-veg')
                ? false
                : Boolean(card.querySelector('[type="veg"], [class*="veg"]'));

          items.push({
            name,
            price_text: (priceCandidate?.textContent || '').trim(),
            description: (descEl?.textContent || '').trim(),
            is_veg,
            image_url: img?.src || img?.getAttribute('data-src') || '',
            category: currentCategory,
          });

          if (items.length >= 200) {
            break;
          }
        }

        // Deduplicate by name+price
        const seen = new Set<string>();
        return items.filter((item) => {
          const key = `${item.name}|${item.price_text}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });
      });

      const data: ZomatoMenuItem[] = rawItems.map((item) => ({
        name: cleanText(item.name),
        price: extractPrice(item.price_text),
        description: cleanText(item.description),
        is_veg: item.is_veg,
        image_url: item.image_url,
        category: cleanText(item.category) || 'General',
      }));

      logger.info('[zomato] Menu scrape completed', {
        restaurantUrl,
        count: data.length,
      });

      return { success: true, data };
    } catch (error) {
      const message = (error as Error).message;
      await this.takeScreenshot('zomato-menu-error');
      logger.error('[zomato] getRestaurantMenu failed', { error: message });
      return {
        success: false,
        data: [],
        error: message || 'Failed to scrape Zomato menu',
      };
    }
  }

  /** BaseScraper contract — delegates to searchItems. */
  async search(query: string, location: string): Promise<SearchItemsResult> {
    return this.searchItems(query, location);
  }

  /** BaseScraper contract — treat itemId as a restaurant/menu URL. */
  async getItemDetails(itemId: string): Promise<RestaurantMenuResult> {
    return this.getRestaurantMenu(itemId);
  }

  private async handleLocationPopup(): Promise<void> {
    const page = this.ensurePage();
    const defaultLocation = env.scrapper.defaultLocation;

    try {
      // TODO: location modal selectors change frequently
      const useCurrent = page.getByRole('button', {
        name: /use current location|detect my location/i,
      });
      if (await useCurrent.isVisible({ timeout: 2500 }).catch(() => false)) {
        // Prefer typing a city over geolocation permissions in headless CI
        logger.debug('[zomato] Location popup visible — skipping geolocation');
      }

      const locationInput = page.locator(
        'input[placeholder*="location" i], input[placeholder*="Search for area" i]'
      );
      if (await locationInput.first().isVisible({ timeout: 2500 }).catch(() => false)) {
        await locationInput.first().fill(defaultLocation);
        await delay(800);
        await page.keyboard.press('Enter');
        await delay(1000);
        logger.info('[zomato] Applied default location', { defaultLocation });
      }
    } catch (error) {
      logger.debug('[zomato] Location popup handling skipped', {
        error: (error as Error).message,
      });
    }
  }

  private async scrollToLoadMenu(): Promise<void> {
    const page = this.ensurePage();

    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await delay(600);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(400);
  }

  private normalizeLocation(location: string): string {
    return cleanText(location)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  /**
   * Map user locations to Zomato city slugs.
   * Noida / Gurgaon / Delhi use `ncr`, not `noida`.
   */
  private resolveZomatoCity(location: string): { citySlug: string; placeHint: string } {
    const placeHint = cleanText(location);
    const normalized = this.normalizeLocation(location);

    const aliases: Record<string, string> = {
      ncr: 'ncr',
      'delhi-ncr': 'ncr',
      delhi: 'ncr',
      'new-delhi': 'ncr',
      noida: 'ncr',
      'greater-noida': 'ncr',
      gurgaon: 'ncr',
      gurugram: 'ncr',
      ghaziabad: 'ncr',
      faridabad: 'ncr',
      bangalore: 'bangalore',
      bengaluru: 'bangalore',
      mumbai: 'mumbai',
      pune: 'pune',
      hyderabad: 'hyderabad',
      chennai: 'chennai',
      kolkata: 'kolkata',
    };

    if (aliases[normalized]) {
      return { citySlug: aliases[normalized], placeHint };
    }

    // "noida-sector-20", "sector-20-noida", "noida sector 20"
    if (/(^|-)noida($|-)/.test(normalized) || normalized.includes('greater-noida')) {
      return { citySlug: 'ncr', placeHint };
    }
    if (/(^|-)(gurgaon|gurugram|ghaziabad|faridabad|delhi)($|-)/.test(normalized)) {
      return { citySlug: 'ncr', placeHint };
    }

    // First token fallback: "noida-sector-20" → try "noida"
    const first = normalized.split('-')[0];
    if (aliases[first]) {
      return { citySlug: aliases[first], placeHint };
    }

    return { citySlug: normalized || env.scrapper.defaultLocation, placeHint };
  }

  /** Try to pin Zomato location UI to a place like "Sector 20, Noida". */
  private async applyPlaceHint(placeHint: string): Promise<void> {
    const page = this.ensurePage();
    try {
      const locationInput = page.locator(
        'input[placeholder*="location" i], input[placeholder*="Search for area" i], input[placeholder*="Detect" i]'
      );
      if (!(await locationInput.first().isVisible({ timeout: 2000 }).catch(() => false))) {
        return;
      }

      await locationInput.first().click({ timeout: 2000 }).catch(() => undefined);
      await locationInput.first().fill('');
      await locationInput.first().fill(placeHint);
      await delay(800);
      await page.keyboard.press('Enter');
      await delay(1200);
      logger.info('[zomato] Applied place hint', { placeHint });
    } catch (error) {
      logger.debug('[zomato] place hint skipped', { error: (error as Error).message });
    }
  }

  private isRestaurantUrl(url: string, city: string): boolean {
    try {
      const pathname = new URL(url).pathname.replace(/\/+$/, '');
      if (/\/delivery\/dish-/i.test(pathname)) return false;
      if (/\/collections?/i.test(pathname)) return false;
      const re = new RegExp(
        `^\\/${city}\\/(?!delivery$|restaurants$)([a-z0-9][a-z0-9-]{2,})(\\/(order|info))?$`,
        'i'
      );
      return re.test(pathname);
    } catch {
      return false;
    }
  }

  private sanitizeImageUrl(src: string): string {
    if (!src) return '';
    if (src.startsWith('data:')) return '';
    if (/placeholder/i.test(src)) return '';
    if (!/^https?:\/\//i.test(src)) return '';
    // Reject accidental page URLs captured as images
    if (/zomato\.com\/.+\/(delivery|order)/i.test(src) && !/zmtcdn|cloudinary/i.test(src)) {
      return '';
    }
    return src;
  }

  private extractRestaurantId(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split('/').filter(Boolean);
      // e.g. /bangalore/restaurant-name/order → restaurant-name
      if (parts.length >= 2 && parts[0] && parts[1] !== 'delivery') {
        return parts[1];
      }
      return parts[parts.length - 1] || url;
    } catch {
      return url;
    }
  }
}

export default ZomatoScraper;
