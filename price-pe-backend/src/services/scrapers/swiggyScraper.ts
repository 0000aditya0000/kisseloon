import env from '../../config/env';
import logger from '../../config/logger';
import type {
  PlatformMenuItem,
  RestaurantMenuResult,
  SearchItemsResult,
  SwiggySearchItem,
} from '../../types/scraper';
import {
  cleanText,
  delay,
  extractDeliveryTime,
  extractPrice,
  extractRating,
} from '../../utils/scraperHelpers';
import { BaseScraper } from './baseScraper';

const PLACEHOLDER = 'https://via.placeholder.com/150?text=No+Image';

/**
 * Swiggy public-page scraper.
 *
 * Swiggy heavily uses dynamic CSS-module class names. Prefer data-testid /
 * role / text selectors over class chains.
 *
 * TODO: If DOM scraping proves too brittle, intercept the search API response
 * with Playwright `page.on('response', ...)` (look for URLs containing
 * `/dapi/restaurants/search` or similar) and parse the JSON payload before
 * it renders to the DOM.
 */
export class SwiggyScraper extends BaseScraper {
  private currentLocation = '';

  constructor() {
    super('swiggy');
  }

  async initialize(): Promise<void> {
    await super.initialize();

    try {
      logger.info('[swiggy] Warming up session (non-fatal)', {
        url: 'https://www.swiggy.com/',
      });
      await this.gotoWithRetry('https://www.swiggy.com/', {
        timeoutMs: 60_000,
        retries: 2,
      });

      await this.setLocation(this.toSwiggyDeliveryPin(env.scrapper.defaultLocation));
      await delay(2000);

      const blocked = await this.detectSwiggyBlock();
      if (blocked) {
        logger.warn('[swiggy] Warm-up may be blocked', { blocked });
        await this.takeScreenshot('swiggy-init-blocked');
        this.lastError = blocked;
      } else {
        logger.info('[swiggy] Warm-up navigation succeeded');
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      logger.warn('[swiggy] Warm-up failed — browser stays ready for scrape retries', {
        error: this.lastError,
      });
      await this.takeScreenshot('swiggy-init-warmup-failed');
    }
  }

  /**
   * Dish search via Swiggy search page (Dishes tab).
   * https://www.swiggy.com/search?query=biryani
   *
   * Strategy: intercept `/dapi/...search...` JSON when available, else parse DOM.
   * (DOM class names are CSS-module hashed and change often.)
   */
  async searchItems(query: string, location: string): Promise<SearchItemsResult> {
    try {
      const page = this.ensurePage();
      const place = this.toSwiggyPlace(location);
      const citySlug = this.toSwiggyCitySlug(location);
      // Pin city first via /city/{slug}, then use the global search path
      // (Swiggy's /city/.../search URLs are unreliable / often empty).
      const searchUrl = `https://www.swiggy.com/search?query=${encodeURIComponent(query)}`;

      logger.info('[swiggy] Dish search', {
        query,
        inputLocation: location,
        place,
        citySlug,
        searchUrl,
      });

      await delay(Math.min(env.scrapper.requestDelay, 1000));

      // Always re-pin city before search — Swiggy often sticks to IP/last city (e.g. Noida)
      await this.ensureCityContext(location);
      await delay(1000);

      // Rewrite lat/lng on Swiggy dapi calls — UI pin alone often keeps IP coords
      const coords = this.cityCoordinates(citySlug);
      const rewriteCoords = async (route: import('playwright').Route): Promise<void> => {
        if (!coords) {
          await route.continue();
          return;
        }
        try {
          const url = new URL(route.request().url());
          if (url.searchParams.has('lat') && url.searchParams.has('lng')) {
            url.searchParams.set('lat', String(coords.lat));
            url.searchParams.set('lng', String(coords.lng));
            await route.continue({ url: url.toString() });
            return;
          }
        } catch {
          // fall through
        }
        await route.continue();
      };
      await page.route('**/dapi/**', rewriteCoords);

      const apiItems: SwiggySearchItem[] = [];
      const seenApiUrls = new Set<string>();
      const onResponse = async (response: import('playwright').Response): Promise<void> => {
        try {
          const url = response.url();
          if (!/swiggy\.com\/dapi\//i.test(url) || response.status() !== 200) {
            return;
          }
          if (seenApiUrls.has(url)) {
            return;
          }
          seenApiUrls.add(url);

          const json = (await response.json().catch(() => null)) as unknown;
          if (!json) {
            return;
          }
          const parsed = this.parseSearchApiPayload(json, query);
          const latLng = url.match(/lat=([^&]+).*lng=([^&]+)/);
          logger.debug('[swiggy] dapi response', {
            url: url.slice(0, 160),
            lat: latLng?.[1],
            lng: latLng?.[2],
            parsed: parsed.length,
          });
          if (parsed.length > 0) {
            apiItems.push(...parsed);
          }
        } catch {
          // ignore non-JSON / aborted responses
        }
      };

      page.on('response', onResponse);

      try {
        await this.gotoWithRetry(searchUrl, { timeoutMs: 75_000, retries: 2 });

        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
          logger.debug('[swiggy] networkidle wait skipped');
        });

        const blocked = await this.detectSwiggyBlock();
        if (blocked) {
          await this.takeScreenshot('swiggy-search-blocked');
          return { success: false, data: [], error: blocked };
        }

        await this.dismissLocationModalIfNeeded(place);
        await this.clickDishesTab();
        // Dishes tab click often triggers a second search API call
        await delay(2500);

        // ADD buttons are the most reliable Dishes-tab signal
        await page
          .getByText(/^ADD$/i)
          .first()
          .waitFor({ timeout: 20_000 })
          .catch(() => {
            logger.warn('[swiggy] No ADD buttons found quickly');
          });

        await page.evaluate(() => window.scrollBy(0, 700));
        await delay(1000);
        await page.evaluate(() => window.scrollBy(0, 700));
        await delay(800);
      } finally {
        page.off('response', onResponse);
        await page.unroute('**/dapi/**', rewriteCoords).catch(() => undefined);
      }

      let data = this.dedupeItems(apiItems);

      if (data.length === 0) {
        logger.info('[swiggy] API parse empty — falling back to DOM scrape');
        data = await this.scrapeDishesFromDom(query);
      }

      // Drop listings clearly from another Swiggy city (e.g. noida when bangalore requested).
      // If filtering would wipe everything, keep the scrape and warn — location pin likely failed.
      if (citySlug && data.length > 0) {
        const inCity = data.filter((item) => this.deepLinkMatchesCity(item.deep_link, citySlug));
        if (inCity.length > 0) {
          if (inCity.length < data.length) {
            logger.info('[swiggy] Filtered out-of-city listings', {
              citySlug,
              removed: data.length - inCity.length,
              kept: inCity.length,
            });
          }
          data = inCity;
        } else {
          logger.warn('[swiggy] All listings outside requested city — location pin may have failed', {
            citySlug,
            sampleLink: data[0]?.deep_link,
          });
        }
      }

      logger.info('[swiggy] Dish search completed', {
        query,
        place,
        citySlug,
        filtered: data.length,
        sample: data.slice(0, 8).map((d) => `${d.dish_name} @ ${d.restaurant_name}`),
      });

      if (data.length === 0) {
        await this.takeScreenshot('swiggy-search-empty');
      }

      return { success: true, data };
    } catch (error) {
      const message = (error as Error).message;
      await this.takeScreenshot('swiggy-search-error');
      logger.error('[swiggy] searchItems failed', { error: message });
      return {
        success: false,
        data: [],
        error: message || 'Failed to scrape Swiggy dish search results',
      };
    }
  }

  /** DOM fallback for Dishes tab: cards keyed off ADD buttons (₹ may be split/SVG). */
  private async scrapeDishesFromDom(query: string): Promise<SwiggySearchItem[]> {
    const page = this.ensurePage();
    const queryLower = query.toLowerCase().trim();

    const rawCards = await page.evaluate(() => {
      type RawCard = {
        dish_name: string;
        restaurant_name: string;
        restaurant_url: string;
        price_text: string;
        rating_text: string;
        delivery_text: string;
        image_url: string;
        is_veg: boolean;
      };

      const cards: RawCard[] = [];
      const seen = new Set<string>();

      const textOf = (el: Element | null | undefined): string =>
        (el?.textContent || '').replace(/\s+/g, ' ').trim();

      const absoluteUrl = (href: string): string => {
        try {
          return new URL(href, 'https://www.swiggy.com').href;
        } catch {
          return href;
        }
      };

      // ADD CTAs are unique to dish cards on the Dishes tab
      const addNodes = Array.from(document.querySelectorAll('div, span, button')).filter((el) => {
        const t = textOf(el);
        return /^add$/i.test(t);
      });

      for (const addNode of addNodes) {
        let card: HTMLElement | null = addNode as HTMLElement;
        let best: HTMLElement | null = null;
        for (let i = 0; i < 12 && card; i++) {
          const t = textOf(card);
          const hasMedia =
            Boolean(card.querySelector('img')) ||
            Boolean(card.querySelector('[style*="background" i]'));
          const hasDigits = /\d{2,5}/.test(t);
          if (hasMedia && hasDigits && t.length > 12 && t.length < 900) {
            best = card;
            if (t.length < 420) {
              break;
            }
          }
          card = card.parentElement;
        }
        card = best;
        if (!card) {
          continue;
        }

        const cardText = textOf(card);

        // ₹ may be an icon (not in text). Prefer currency match, else digits near ADD.
        const priceMatch =
          cardText.match(/(?:₹|rs\.?)\s*(\d{2,5}(?:\.\d{1,2})?)/i) ||
          cardText.match(/(\d{2,5}(?:\.\d{1,2})?)(?=[^\d]{0,20}add)/i);
        if (!priceMatch) {
          continue;
        }
        const priceNum = Math.round(Number(priceMatch[1]));
        if (!Number.isFinite(priceNum) || priceNum < 20 || priceNum > 20000) {
          continue;
        }
        const price_text = `₹${priceNum}`;

        // Collect short leaf texts for dish name
        const leafTexts = Array.from(card.querySelectorAll('div, span, p, h1, h2, h3, h4'))
          .map((el) => textOf(el))
          .filter((t) => {
            if (!t || t.length < 3 || t.length > 90) return false;
            if (/^(?:₹|rs\.?)/i.test(t)) return false;
            if (/^\d{2,5}$/.test(t)) return false;
            if (/^add$/i.test(t)) return false;
            if (/customisable|customizable/i.test(t)) return false;
            if (/^\d(?:\.\d)?$/.test(t)) return false;
            if (/★/.test(t)) return false;
            if (/mins?/i.test(t)) return false;
            if (/^\(\d/.test(t)) return false;
            return true;
          });

        const dish_name = leafTexts.find((t) => t.length >= 4) || leafTexts[0] || '';
        if (!dish_name) {
          continue;
        }

        let restaurant_name = '';
        let restaurant_url = '';
        let delivery_text = '';
        let rating_text = '';

        let probe: HTMLElement | null = card;
        for (let depth = 0; depth < 8 && probe && !restaurant_name; depth++) {
          let sib = probe.previousElementSibling as HTMLElement | null;
          for (let s = 0; s < 6 && sib; s++) {
            const st = textOf(sib);
            if (st.length > 120 || st.length < 3) {
              sib = sib.previousElementSibling as HTMLElement | null;
              continue;
            }
            if (/\d+\s*[-–]?\s*\d*\s*mins?/i.test(st) || /\d(?:\.\d)?\s*\([\d.k+]+\)/i.test(st)) {
              const link =
                (sib.querySelector('a[href]') as HTMLAnchorElement | null) ||
                (sib.closest('a[href]') as HTMLAnchorElement | null) ||
                (sib.tagName === 'A' ? (sib as HTMLAnchorElement) : null);
              if (link) {
                restaurant_url = absoluteUrl(link.getAttribute('href') || link.href);
              }
              const nameCandidate = st
                .split(/\d(?:\.\d)?\s*\(/)[0]
                .split(/\d+\s*[-–]\s*\d+\s*mins?/i)[0]
                .replace(/[•·|].*$/, '')
                .trim();
              if (nameCandidate.length >= 2 && nameCandidate.length < 80) {
                restaurant_name = nameCandidate;
              }
              const del = st.match(/\d+\s*[-–]\s*\d+\s*mins?|\d+\s*mins?/i);
              delivery_text = del?.[0] || '';
              const rat = st.match(/(\d(?:\.\d)?)\s*\(/);
              rating_text = rat?.[1] || '';
              break;
            }
            sib = sib.previousElementSibling as HTMLElement | null;
          }
          // Also try parent-level links
          if (!restaurant_url) {
            const parentLink = probe.parentElement?.querySelector(
              'a[href*="restaurant"]'
            ) as HTMLAnchorElement | null;
            if (parentLink) {
              restaurant_url = absoluteUrl(parentLink.getAttribute('href') || parentLink.href);
              if (!restaurant_name) {
                restaurant_name = textOf(parentLink).split(/\d/)[0].trim().slice(0, 80);
              }
            }
          }
          probe = probe.parentElement;
        }

        if (!rating_text) {
          const dishRating =
            cardText.match(/★\s*(\d(?:\.\d)?)/) || cardText.match(/(\d(?:\.\d)?)\s*\(\d/);
          rating_text = dishRating?.[1] || '';
        }

        const img = card.querySelector('img') as HTMLImageElement | null;
        const image_url =
          img?.src ||
          img?.getAttribute('data-src') ||
          img?.getAttribute('srcset')?.split(/\s+/)[0] ||
          '';

        const html = (card.innerHTML || '').toLowerCase();
        let is_veg = false;
        if (html.includes('non-veg') || html.includes('nonveg') || html.includes('#e23744')) {
          is_veg = false;
        } else if (html.includes('veg') || /#0f8a65|#3d9b6e|0f8a65|green/i.test(html)) {
          is_veg = true;
        }

        if (!restaurant_name) {
          restaurant_name = 'Unknown restaurant';
        }
        if (!restaurant_url) {
          restaurant_url = 'https://www.swiggy.com/restaurants';
        }

        const key = `${dish_name}|${restaurant_name}|${price_text}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        cards.push({
          dish_name,
          restaurant_name,
          restaurant_url,
          price_text,
          rating_text,
          delivery_text,
          image_url,
          is_veg,
        });

        if (cards.length >= 40) {
          break;
        }
      }

      return { cards, addCount: addNodes.length };
    });

    logger.info('[swiggy] DOM scrape stats', {
      addButtons: rawCards.addCount,
      rawCards: rawCards.cards.length,
    });

    const data: SwiggySearchItem[] = [];
    for (const card of rawCards.cards) {
      const dish_name = this.cleanDishName(card.dish_name);
      const restaurant_name = this.cleanRestaurantName(card.restaurant_name);
      const matchesQuery = dish_name.toLowerCase().includes(queryLower);
      if (!matchesQuery) {
        continue;
      }
      if (!restaurant_name || restaurant_name.length < 2) {
        continue;
      }

      data.push({
        dish_name,
        restaurant_name,
        restaurant_id: this.extractRestaurantId(card.restaurant_url),
        price: extractPrice(card.price_text),
        rating: extractRating(card.rating_text),
        delivery_time_min: extractDeliveryTime(card.delivery_text),
        image_url: this.sanitizeImageUrl(card.image_url) || PLACEHOLDER,
        is_veg: card.is_veg,
        deep_link: card.restaurant_url,
      });
    }

    return this.dedupeItems(data);
  }

  /** Strip trailing rating/price glued onto dish titles by CSS-module DOM text. */
  private cleanDishName(raw: string): string {
    let name = cleanText(raw);

    // Aria-style: "Non-veg item. Chicken Biryani. Costs: 275 rupees, ..."
    const ariaDish = name.match(
      /(?:veg item|non-veg item)\.\s*(.+?)\.\s*costs:/i
    );
    if (ariaDish?.[1]) {
      name = ariaDish[1].trim();
    }

    // "Style3.7(4)229.52" / "Biryani4.3(12)399" / "Bowl4.4(11.9K+)350"
    name = name.replace(
      /\d(?:\.\d)?\s*\([\d.kK+]+\)\s*\d+(?:\.\d+)?\s*$/g,
      ''
    );
    name = name.replace(/\d(?:\.\d)?\s*\([\d.kK+]+\)\s*$/g, '');
    name = name.replace(/(?:₹|rs\.?)\s*\d[\d.]*\s*$/i, '');
    name = name.replace(/\d+(?:\.\d+)?\s*$/g, (m, offset, full) => {
      const prev = full[offset - 1];
      return prev && /[a-zA-Z)\]]/.test(prev) ? '' : m;
    });
    // Trailing tags like "[km]" from Swiggy distance badges
    name = name.replace(/\[km\]\s*$/i, '');

    return cleanText(name);
  }

  /**
   * Force Swiggy session into the requested city by setting a real delivery pin.
   * `/city/{slug}` alone does NOT update lat/lng cookies — search still uses IP city.
   */
  private async ensureCityContext(location: string): Promise<void> {
    const place = this.toSwiggyPlace(location);
    const pin = this.toSwiggyDeliveryPin(location);
    const citySlug = this.toSwiggyCitySlug(location);

    await this.gotoWithRetry('https://www.swiggy.com/', { timeoutMs: 60_000, retries: 2 });
    await this.setLocation(pin);

    const page = this.ensurePage();
    const url = page.url().toLowerCase();
    logger.info('[swiggy] City context after location pin', {
      place,
      pin,
      citySlug,
      url: page.url(),
    });

    // If still not in the city path, open city hub then re-pin
    if (citySlug && !url.includes(citySlug) && !url.includes('swiggy.com/search')) {
      await this.gotoWithRetry(`https://www.swiggy.com/city/${citySlug}`, {
        timeoutMs: 60_000,
        retries: 1,
      });
      await this.setLocation(pin);
    }

    this.currentLocation = place;
  }

  /** Representative lat/lng for Swiggy search API (Koramangala, CP, etc.). */
  private cityCoordinates(
    citySlug: string
  ): { lat: number; lng: number } | null {
    const map: Record<string, { lat: number; lng: number }> = {
      bangalore: { lat: 12.9352, lng: 77.6245 },
      mumbai: { lat: 19.1197, lng: 72.8468 },
      pune: { lat: 18.5362, lng: 73.8939 },
      hyderabad: { lat: 17.4435, lng: 78.3772 },
      chennai: { lat: 13.0418, lng: 80.2341 },
      kolkata: { lat: 22.5541, lng: 88.3509 },
      delhi: { lat: 28.6315, lng: 77.2167 },
      noida: { lat: 28.5708, lng: 77.3219 },
      gurgaon: { lat: 28.4949, lng: 77.0885 },
      ghaziabad: { lat: 28.6415, lng: 77.3584 },
      faridabad: { lat: 28.4089, lng: 77.3178 },
    };
    return map[citySlug] ?? null;
  }

  /** Concrete area pin so Swiggy sets lat/lng (city name alone is too vague). */
  private toSwiggyDeliveryPin(location: string): string {
    const slug = this.toSwiggyCitySlug(location);
    const pins: Record<string, string> = {
      bangalore: 'Koramangala, Bangalore',
      mumbai: 'Andheri West, Mumbai',
      pune: 'Koregaon Park, Pune',
      hyderabad: 'Hitech City, Hyderabad',
      chennai: 'T Nagar, Chennai',
      kolkata: 'Park Street, Kolkata',
      delhi: 'Connaught Place, New Delhi',
      noida: 'Sector 18, Noida',
      gurgaon: 'Cyber Hub, Gurugram',
      ghaziabad: 'Indirapuram, Ghaziabad',
      faridabad: 'Sector 15, Faridabad',
    };
    if (slug && pins[slug]) {
      return pins[slug];
    }
    // If user already sent an area ("Sector 20, Noida"), keep it
    const raw = cleanText(location);
    if (/,/.test(raw) || /\d/.test(raw) || /\bsector\b/i.test(raw)) {
      return raw;
    }
    return this.toSwiggyPlace(location);
  }

  /** True when deep link is city-agnostic or matches the requested Swiggy city slug. */
  private deepLinkMatchesCity(deepLink: string, citySlug: string): boolean {
    try {
      const path = new URL(deepLink, 'https://www.swiggy.com').pathname.toLowerCase();
      const cityInPath = path.match(/\/city\/([^/]+)/);
      if (!cityInPath) {
        return true; // no city segment — keep
      }
      const linkCity = cityInPath[1];
      // Swiggy sometimes uses noida-1, bangalore, etc.
      if (linkCity === citySlug || linkCity.startsWith(`${citySlug}-`)) {
        return true;
      }
      // Aliases: bengaluru ↔ bangalore
      if (
        (citySlug === 'bangalore' && linkCity.startsWith('bengaluru')) ||
        (citySlug === 'delhi' && /^(delhi|noida|gurgaon|gurugram)/.test(linkCity))
      ) {
        return citySlug === 'delhi' || linkCity.startsWith('bengaluru');
      }
      return false;
    } catch {
      return true;
    }
  }

  /** Drop ad/badge prefixes like "Ad" stuck onto restaurant names. */
  private cleanRestaurantName(raw: string): string {
    let name = cleanText(raw);
    // Only strip a lone "Ad" badge glued to a capital letter (AdCharcoal → Charcoal)
    name = name.replace(/^Ad(?=[A-Z])/, '');
    return cleanText(name);
  }

  /**
   * Walk Swiggy search JSON for dish entities.
   * Structure varies; we recurse for objects with name + price + restaurant.
   */
  private parseSearchApiPayload(payload: unknown, query: string): SwiggySearchItem[] {
    const queryLower = query.toLowerCase().trim();
    const found: SwiggySearchItem[] = [];
    const seen = new Set<string>();

    const visit = (node: unknown, ctx: { restaurant?: string; restaurantId?: string; delivery?: string; rating?: number }): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (Array.isArray(node)) {
        for (const child of node) {
          visit(child, ctx);
        }
        return;
      }

      const obj = node as Record<string, unknown>;
      const info =
        (obj.info as Record<string, unknown> | undefined) ||
        (obj.card as Record<string, unknown> | undefined)?.info as
          | Record<string, unknown>
          | undefined ||
        obj;

      const restaurantName =
        (typeof info.restaurantName === 'string' && info.restaurantName) ||
        (typeof info.name === 'string' &&
        typeof info.sla === 'object' &&
        !('price' in info) &&
        !('defaultPrice' in info)
          ? info.name
          : '') ||
        ctx.restaurant ||
        '';

      const restaurantId =
        (typeof info.restaurantId === 'string' && info.restaurantId) ||
        (typeof info.id === 'string' || typeof info.id === 'number'
          ? String(info.id)
          : '') ||
        ctx.restaurantId ||
        '';

      const nextCtx = {
        restaurant: restaurantName || ctx.restaurant,
        restaurantId: restaurantId || ctx.restaurantId,
        delivery:
          (typeof (info.sla as { slaString?: string } | undefined)?.slaString === 'string'
            ? (info.sla as { slaString: string }).slaString
            : ctx.delivery) || ctx.delivery,
        rating:
          typeof info.avgRating === 'number'
            ? info.avgRating
            : typeof info.avgRatingString === 'string'
              ? Number(info.avgRatingString) || ctx.rating
              : ctx.rating,
      };

      const dishName =
        (typeof info.name === 'string' &&
        ('price' in info || 'defaultPrice' in info || 'finalPrice' in info)
          ? info.name
          : '') ||
        (typeof info.dishName === 'string' ? info.dishName : '') ||
        '';

      const priceRaw =
        info.price ?? info.defaultPrice ?? info.finalPrice ?? info.itemPrice;
      let price = 0;
      if (typeof priceRaw === 'number') {
        // Swiggy often stores paise (×100)
        price = priceRaw > 1000 ? Math.round(priceRaw / 100) : priceRaw;
      } else if (typeof priceRaw === 'string') {
        price = extractPrice(priceRaw);
      }

      if (
        dishName &&
        price > 0 &&
        dishName.toLowerCase().includes(queryLower) &&
        (nextCtx.restaurant || restaurantName)
      ) {
        const rName = nextCtx.restaurant || restaurantName || 'Unknown restaurant';
        const rId =
          nextCtx.restaurantId ||
          restaurantId ||
          rName
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
        const key = `${dishName}|${rName}|${price}`;
        if (!seen.has(key)) {
          seen.add(key);
          const image =
            (typeof info.imageId === 'string' && info.imageId
              ? `https://media-assets.swiggy.com/swiggy/image/upload/${info.imageId}`
              : '') ||
            (typeof info.cloudinaryImageId === 'string' && info.cloudinaryImageId
              ? `https://media-assets.swiggy.com/swiggy/image/upload/${info.cloudinaryImageId}`
              : '');

          const isVeg =
            info.isVeg === true ||
            info.isVeg === 1 ||
            info.vegClassifier === 'VEG' ||
            info.itemAttribute === 'VEG';

          found.push({
            dish_name: dishName,
            restaurant_name: rName,
            restaurant_id: rId,
            price,
            rating:
              typeof info.rating === 'number'
                ? info.rating
                : typeof (info.ratings as { aggregatedRating?: { rating?: string } })?.aggregatedRating
                      ?.rating === 'string'
                  ? Number(
                      (info.ratings as { aggregatedRating: { rating: string } })
                        .aggregatedRating.rating
                    ) || nextCtx.rating || 0
                  : nextCtx.rating || 0,
            delivery_time_min: extractDeliveryTime(nextCtx.delivery || ''),
            image_url: image || PLACEHOLDER,
            is_veg: Boolean(isVeg),
            deep_link: `https://www.swiggy.com/restaurants/${rId}`,
          });
        }
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
          visit(value, nextCtx);
        }
      }
    };

    visit(payload, {});
    return found;
  }

  private dedupeItems(items: SwiggySearchItem[]): SwiggySearchItem[] {
    const seen = new Set<string>();
    const out: SwiggySearchItem[] = [];
    for (const item of items) {
      const key = `${item.dish_name}|${item.restaurant_name}|${item.price}|${item.restaurant_id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  /**
   * Full restaurant menu from a Swiggy restaurant URL.
   * Prefers `/dapi/` menu JSON; falls back to DOM (ADD buttons + price).
   */
  async getRestaurantMenu(restaurantUrl: string): Promise<RestaurantMenuResult> {
    try {
      const page = this.ensurePage();
      const url = this.normalizeSwiggyRestaurantUrl(restaurantUrl);

      logger.info('[swiggy] Fetching restaurant menu', { restaurantUrl: url });
      await delay(Math.min(env.scrapper.requestDelay, 1000));

      const apiItems: PlatformMenuItem[] = [];
      const seenApiUrls = new Set<string>();

      const onResponse = async (response: import('playwright').Response): Promise<void> => {
        try {
          const respUrl = response.url();
          if (!/swiggy\.com\/dapi\//i.test(respUrl) || response.status() !== 200) {
            return;
          }
          if (!/(menu|items|restaurant)/i.test(respUrl)) {
            return;
          }
          if (seenApiUrls.has(respUrl)) {
            return;
          }
          seenApiUrls.add(respUrl);

          const json = (await response.json().catch(() => null)) as unknown;
          if (!json) {
            return;
          }
          const parsed = this.parseMenuApiPayload(json);
          if (parsed.length > 0) {
            apiItems.push(...parsed);
          }
        } catch {
          // ignore
        }
      };

      page.on('response', onResponse);

      try {
        await this.gotoWithRetry(url, { timeoutMs: 90_000, retries: 2 });

        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

        const blocked = await this.detectSwiggyBlock();
        if (blocked) {
          await this.takeScreenshot('swiggy-menu-blocked');
          return { success: false, data: [], error: blocked };
        }

        await page
          .getByText(/^ADD$/i)
          .first()
          .waitFor({ timeout: 25_000 })
          .catch(() => {
            logger.warn('[swiggy] Menu ADD buttons not found quickly');
          });

        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await delay(600);
        }
        await delay(1200);
      } finally {
        page.off('response', onResponse);
      }

      let data = this.dedupeMenuItems(apiItems);

      if (data.length === 0) {
        logger.info('[swiggy] Menu API empty — falling back to DOM scrape');
        data = await this.scrapeMenuFromDom();
      }

      logger.info('[swiggy] Menu scrape completed', {
        restaurantUrl: url,
        count: data.length,
      });

      if (data.length === 0) {
        await this.takeScreenshot('swiggy-menu-empty');
        return {
          success: false,
          data: [],
          error: 'No menu items found on Swiggy restaurant page',
        };
      }

      return { success: true, data };
    } catch (error) {
      const message = (error as Error).message;
      await this.takeScreenshot('swiggy-menu-error');
      logger.error('[swiggy] getRestaurantMenu failed', { error: message });
      return {
        success: false,
        data: [],
        error: message || 'Failed to scrape Swiggy menu',
      };
    }
  }

  /** Recursively extract menu line items from Swiggy dapi JSON. */
  private parseMenuApiPayload(payload: unknown): PlatformMenuItem[] {
    const found: PlatformMenuItem[] = [];
    const seen = new Set<string>();

    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (Array.isArray(node)) {
        for (const child of node) {
          visit(child);
        }
        return;
      }

      const obj = node as Record<string, unknown>;
      const info =
        (obj.info as Record<string, unknown> | undefined) ||
        (obj.card as Record<string, unknown> | undefined)?.info as
          | Record<string, unknown>
          | undefined ||
        obj;

      const name =
        (typeof info.name === 'string' &&
        ('price' in info || 'defaultPrice' in info || 'finalPrice' in info)
          ? info.name
          : '') ||
        (typeof info.itemName === 'string' ? info.itemName : '') ||
        '';

      const priceRaw =
        info.price ?? info.defaultPrice ?? info.finalPrice ?? info.itemPrice;
      let price = 0;
      if (typeof priceRaw === 'number') {
        price = priceRaw > 1000 ? Math.round(priceRaw / 100) : priceRaw;
      } else if (typeof priceRaw === 'string') {
        price = extractPrice(priceRaw);
      }

      if (name && price > 0 && name.length >= 2) {
        const key = `${name}|${price}`;
        if (!seen.has(key)) {
          seen.add(key);
          const imageId =
            (typeof info.imageId === 'string' && info.imageId) ||
            (typeof info.cloudinaryImageId === 'string' && info.cloudinaryImageId) ||
            '';
          const image_url = imageId
            ? `https://media-assets.swiggy.com/swiggy/image/upload/${imageId}`
            : undefined;

          const isVeg =
            info.isVeg === true ||
            info.isVeg === 1 ||
            info.vegClassifier === 'VEG' ||
            info.itemAttribute === 'VEG';

          found.push({
            name: this.cleanDishName(name),
            price,
            is_veg: Boolean(isVeg),
            image_url,
            description:
              typeof info.description === 'string' ? cleanText(info.description) : undefined,
            category:
              typeof info.category === 'string'
                ? cleanText(info.category)
                : typeof info.categoryName === 'string'
                  ? cleanText(info.categoryName)
                  : undefined,
          });
        }
      }

      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
          visit(value);
        }
      }
    };

    visit(payload);
    return found;
  }

  private dedupeMenuItems(items: PlatformMenuItem[]): PlatformMenuItem[] {
    const seen = new Set<string>();
    const out: PlatformMenuItem[] = [];
    for (const item of items) {
      const key = `${item.name}|${item.price}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  private normalizeSwiggyRestaurantUrl(raw: string): string {
    const trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith('/')) {
      return `https://www.swiggy.com${trimmed}`;
    }
    return `https://www.swiggy.com/restaurants/${trimmed}`;
  }

  /** DOM fallback on restaurant menu page — dish cards keyed off ADD CTAs. */
  private async scrapeMenuFromDom(): Promise<PlatformMenuItem[]> {
    const page = this.ensurePage();

    const rawItems = await page.evaluate(() => {
      type RawItem = {
        name: string;
        price_text: string;
        is_veg: boolean;
        image_url: string;
      };

      const items: RawItem[] = [];
      const seen = new Set<string>();

      const textOf = (el: Element | null | undefined): string =>
        (el?.textContent || '').replace(/\s+/g, ' ').trim();

      const addNodes = Array.from(document.querySelectorAll('div, span, button')).filter((el) =>
        /^add$/i.test(textOf(el))
      );

      for (const addNode of addNodes) {
        let card: HTMLElement | null = addNode as HTMLElement;
        let best: HTMLElement | null = null;
        for (let i = 0; i < 10 && card; i++) {
          const t = textOf(card);
          const hasMedia = Boolean(card.querySelector('img'));
          const hasDigits = /\d{2,5}/.test(t);
          if (hasMedia && hasDigits && t.length > 8 && t.length < 600) {
            best = card;
            if (t.length < 350) {
              break;
            }
          }
          card = card.parentElement;
        }
        card = best;
        if (!card) {
          continue;
        }

        const cardText = textOf(card);
        const priceMatch =
          cardText.match(/(?:₹|rs\.?)\s*(\d{2,5}(?:\.\d{1,2})?)/i) ||
          cardText.match(/(\d{2,5})(?=[^\d]{0,16}add)/i);
        if (!priceMatch) {
          continue;
        }
        const priceNum = Math.round(Number(priceMatch[1]));
        if (!Number.isFinite(priceNum) || priceNum < 15 || priceNum > 25000) {
          continue;
        }

        const leafTexts = Array.from(card.querySelectorAll('div, span, p, h3, h4'))
          .map((el) => textOf(el))
          .filter((t) => {
            if (!t || t.length < 3 || t.length > 100) return false;
            if (/^(?:₹|rs\.?)/i.test(t)) return false;
            if (/^\d{2,5}$/.test(t)) return false;
            if (/^add$/i.test(t)) return false;
            if (/customisable|customizable/i.test(t)) return false;
            return true;
          });

        const name = leafTexts.find((t) => t.length >= 4) || leafTexts[0] || '';
        if (!name) {
          continue;
        }

        const html = (card.innerHTML || '').toLowerCase();
        let is_veg = false;
        if (html.includes('non-veg') || html.includes('nonveg') || html.includes('#e23744')) {
          is_veg = false;
        } else if (html.includes('veg') || /#0f8a65|green/i.test(html)) {
          is_veg = true;
        }

        const img = card.querySelector('img') as HTMLImageElement | null;
        const image_url = img?.src || img?.getAttribute('data-src') || '';

        const key = `${name}|${priceNum}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        items.push({
          name,
          price_text: `₹${priceNum}`,
          is_veg,
          image_url,
        });

        if (items.length >= 200) {
          break;
        }
      }

      return items;
    });

    const data: PlatformMenuItem[] = [];
    for (const item of rawItems) {
      const name = this.cleanDishName(item.name);
      const price = extractPrice(item.price_text);
      if (!name || price <= 0) {
        continue;
      }
      data.push({
        name,
        price,
        is_veg: item.is_veg,
        image_url: this.sanitizeImageUrl(item.image_url) || undefined,
      });
    }

    return this.dedupeMenuItems(data);
  }

  /** BaseScraper contract — delegates to searchItems. */
  async search(query: string, location: string): Promise<SearchItemsResult> {
    return this.searchItems(query, location);
  }

  /** BaseScraper contract — treat itemId as a restaurant/menu URL. */
  async getItemDetails(itemId: string): Promise<RestaurantMenuResult> {
    return this.getRestaurantMenu(itemId);
  }

  /**
   * Handle Swiggy location modal / homepage delivery-location field.
   * Robust against overlays that block the rest of the UI.
   */
  private async setLocation(location: string): Promise<void> {
    const page = this.ensurePage();
    const place = this.toSwiggyPlace(location);
    const citySlug = this.toSwiggyCitySlug(location);

    try {
      logger.info('[swiggy] Setting location', { place, citySlug });

      // Let the orange homepage / modal finish painting
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
      await delay(1500);

      // Clear cookie consent / overlays that can steal clicks
      const consent = page.getByRole('button', {
        name: /accept|agree|got it|ok|close/i,
      });
      if (await consent.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await consent.first().click({ timeout: 2000 }).catch(() => undefined);
      }

      // Homepage uses: "Enter your delivery location"
      // In-app modal uses: "Search for area, street name…"
      const locationInput = page
        .getByPlaceholder(/enter your delivery location/i)
        .or(page.getByPlaceholder(/search for area/i))
        .or(page.getByPlaceholder(/sector, colony/i))
        .or(page.getByPlaceholder(/delivery location/i))
        .or(
          page.locator(
            [
              'input[placeholder*="Enter your delivery location" i]',
              'input[placeholder*="Search for area" i]',
              'input[placeholder*="location" i]',
              'input#location',
              'input[name="location"]',
            ].join(', ')
          )
        );

      // Sometimes need to click the location chip / pin area first
      if (!(await locationInput.first().isVisible({ timeout: 4000 }).catch(() => false))) {
        const locationTrigger = page.locator(
          [
            'text=/Enter your delivery location/i',
            '[data-testid*="location" i]',
            'span[class*="Location"]',
            'div[class*="Location"]',
            'button:has-text("Other")',
            'a:has-text("Other")',
          ].join(', ')
        );
        if (await locationTrigger.first().isVisible({ timeout: 2500 }).catch(() => false)) {
          await locationTrigger.first().click({ timeout: 3000 }).catch(() => undefined);
          await delay(800);
        }
      }

      if (!(await locationInput.first().isVisible({ timeout: 8000 }).catch(() => false))) {
        // Fallback: city landing page often skips the modal
        if (citySlug) {
          logger.warn('[swiggy] Location input not found — falling back to city URL', {
            citySlug,
          });
          await this.gotoWithRetry(`https://www.swiggy.com/city/${citySlug}`, {
            timeoutMs: 60_000,
            retries: 2,
          });
          this.currentLocation = place;
          return;
        }

        logger.warn('[swiggy] Location input not found — continuing without pin');
        await this.takeScreenshot('swiggy-location-missing');
        return;
      }

      await locationInput.first().click({ timeout: 3000 });
      await locationInput.first().fill('');
      await locationInput.first().pressSequentially(place, { delay: 50 });
      await delay(1500);

      // Prefer a suggestion that mentions the city (avoid IP-local first hit)
      const cityHint = citySlug || place.split(',')[0].trim();
      const suggestion = page
        .locator(
          [
            'button[tabindex="0"]',
            '[data-testid*="autocomplete" i] button',
            '[data-testid*="suggestion" i]',
            'div[class*="AddressList"] > div',
            'div[class*="suggestion" i]',
            'li[role="option"]',
          ].join(', ')
        )
        .or(page.locator('[class*="icon-location"]').locator('xpath=ancestor::*[self::button or self::div][1]'));

      let clicked = false;
      const matching = suggestion.filter({ hasText: new RegExp(cityHint, 'i') });
      if (await matching.first().isVisible({ timeout: 4000 }).catch(() => false)) {
        await matching.first().click({ timeout: 4000 });
        clicked = true;
      } else if (await suggestion.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await suggestion.first().click({ timeout: 4000 });
        clicked = true;
      } else {
        await page.keyboard.press('ArrowDown');
        await delay(200);
        await page.keyboard.press('Enter');
        clicked = true;
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
      await delay(2000);

      // If Swiggy still landed on another city, force city URL
      const landed = page.url().toLowerCase();
      if (citySlug && /\/city\//.test(landed) && !landed.includes(`/city/${citySlug}`)) {
        logger.warn('[swiggy] Autocomplete landed on wrong city — forcing city URL', {
          landed: page.url(),
          citySlug,
        });
        await this.gotoWithRetry(`https://www.swiggy.com/city/${citySlug}`, {
          timeoutMs: 60_000,
          retries: 1,
        });
      }

      this.currentLocation = place;
      logger.info('[swiggy] Location applied', { place, clicked, url: page.url() });
    } catch (error) {
      logger.warn('[swiggy] Location modal handling failed', {
        place,
        error: (error as Error).message,
      });
      await this.takeScreenshot('swiggy-location-error');

      // Last resort: city URL
      const citySlug = this.toSwiggyCitySlug(location);
      if (citySlug) {
        try {
          await this.gotoWithRetry(`https://www.swiggy.com/city/${citySlug}`, {
            timeoutMs: 60_000,
            retries: 1,
          });
          this.currentLocation = place;
        } catch {
          // ignore
        }
      }
    }
  }

  /** Map free-text location to Swiggy `/city/{slug}` path segment. */
  private toSwiggyCitySlug(location: string): string {
    const key = cleanText(location)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const aliases: Array<[RegExp, string]> = [
      [/(^|-)(bangalore|bengaluru)($|-)/, 'bangalore'],
      [/(^|-)mumbai($|-)/, 'mumbai'],
      [/(^|-)pune($|-)/, 'pune'],
      [/(^|-)hyderabad($|-)/, 'hyderabad'],
      [/(^|-)chennai($|-)/, 'chennai'],
      [/(^|-)kolkata($|-)/, 'kolkata'],
      [/(^|-)(new-delhi|delhi-ncr|delhi|ncr)($|-)/, 'delhi'],
      [/(^|-)(greater-)?noida($|-)/, 'noida'],
      [/(^|-)(gurgaon|gurugram)($|-)/, 'gurgaon'],
      [/(^|-)ghaziabad($|-)/, 'ghaziabad'],
      [/(^|-)faridabad($|-)/, 'faridabad'],
    ];

    for (const [re, slug] of aliases) {
      if (re.test(key)) {
        return slug;
      }
    }

    return '';
  }

  private async dismissLocationModalIfNeeded(place: string): Promise<void> {
    const page = this.ensurePage();
    const locationInput = page.locator(
      'input[placeholder*="Search for area" i], input[placeholder*="location" i]'
    );
    if (await locationInput.first().isVisible({ timeout: 1500 }).catch(() => false)) {
      logger.info('[swiggy] Location modal still open on search — re-applying');
      await this.setLocation(place);
    }
  }

  private async clickDishesTab(): Promise<void> {
    const page = this.ensurePage();

    try {
      // Swiggy defaults to Restaurants; switch to Dishes when available
      const dishesTab = page
        .getByRole('tab', { name: /^dishes$/i })
        .or(page.getByRole('button', { name: /^dishes$/i }))
        .or(page.locator('div, span, a, button').filter({ hasText: /^Dishes$/i }));

      if (await dishesTab.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await dishesTab.first().click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await delay(1200);
        logger.info('[swiggy] Clicked Dishes tab');
      } else {
        logger.warn('[swiggy] Dishes tab not found — scraping current results');
      }
    } catch (error) {
      logger.debug('[swiggy] Dishes tab click skipped', {
        error: (error as Error).message,
      });
    }
  }

  private toSwiggyPlace(location: string): string {
    const raw = cleanText(location);
    const key = raw
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const aliases: Record<string, string> = {
      bangalore: 'Bangalore',
      bengaluru: 'Bangalore',
      mumbai: 'Mumbai',
      pune: 'Pune',
      hyderabad: 'Hyderabad',
      chennai: 'Chennai',
      kolkata: 'Kolkata',
      delhi: 'Delhi',
      'new-delhi': 'New Delhi',
      ncr: 'Delhi',
      'delhi-ncr': 'Delhi',
      noida: 'Noida',
      'greater-noida': 'Greater Noida',
      gurgaon: 'Gurgaon',
      gurugram: 'Gurugram',
      ghaziabad: 'Ghaziabad',
      faridabad: 'Faridabad',
    };

    if (aliases[key]) {
      return aliases[key];
    }

    // "noida-sector-20" / "Sector 20, Noida" — keep human-readable place string
    if (/(^|-)noida($|-)/.test(key)) {
      return raw.includes(',') || /\d/.test(raw) ? raw : 'Noida';
    }
    if (/(^|-)(gurgaon|gurugram)($|-)/.test(key)) {
      return raw.includes(',') || /\d/.test(raw) ? raw : 'Gurugram';
    }

    const first = key.split('-')[0];
    if (aliases[first]) {
      return aliases[first];
    }

    // Title-case free text for autocomplete
    return raw
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  private extractRestaurantId(url: string): string {
    try {
      const path = new URL(url, 'https://www.swiggy.com').pathname;
      // /restaurants/name-area-restId or /city/restaurants/name-restId
      const match = path.match(/\/restaurants?\/([^/?#]+)/i);
      if (match?.[1]) {
        return match[1];
      }
      const parts = path.split('/').filter(Boolean);
      return parts[parts.length - 1] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private sanitizeImageUrl(url: string): string {
    if (!url) {
      return '';
    }
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    if (url.startsWith('/')) {
      return `https://media-assets.swiggy.com${url}`;
    }
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    return '';
  }

  private async detectSwiggyBlock(): Promise<string | null> {
    const generic = await this.detectBlockOrCaptcha();
    if (generic) {
      return generic.replace(/Zomato/gi, 'Swiggy');
    }

    const page = this.ensurePage();
    try {
      const snippet = await page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .catch(() => '');
      const content = snippet.toLowerCase().slice(0, 4000);
      if (
        content.includes('something went wrong') ||
        content.includes('access to this page has been denied') ||
        content.includes('please verify you are a human')
      ) {
        return 'Possible bot block detected on Swiggy';
      }
    } catch {
      // ignore
    }
    return null;
  }
}

export default SwiggyScraper;
