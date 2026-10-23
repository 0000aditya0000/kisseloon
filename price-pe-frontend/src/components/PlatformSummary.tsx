import { cheapestOnPlatform, formatPrice, platformLabel } from '../lib/format';
import type { ComparisonProduct, SearchMeta } from '../types';

interface PlatformSummaryProps {
  items: ComparisonProduct[];
  meta?: SearchMeta;
  query: string;
}

export function PlatformSummary({ items, meta, query }: PlatformSummaryProps) {
  const zomato = cheapestOnPlatform(items, 'zomato');
  const swiggy = cheapestOnPlatform(items, 'swiggy');
  const succeeded = meta?.platforms?.succeeded ?? [];
  const failed = meta?.platforms?.failed ?? [];

  return (
    <section className="summary" aria-label="Comparison summary">
      <div className="summary__intro">
        <h2 className="summary__title">
          Prices for <em>{query}</em>
        </h2>
        <p className="summary__count">{items.length} offers found</p>
      </div>

      <div className="summary__grid">
        <article className={`summary__card summary__card--zomato ${zomato ? '' : 'is-empty'}`}>
          <p className="summary__platform">{platformLabel('zomato')}</p>
          {zomato ? (
            <>
              <p className="summary__price">{formatPrice(zomato.price)}</p>
              <p className="summary__rest">Lowest near {zomato.restaurant_name}</p>
            </>
          ) : (
            <p className="summary__rest">No Zomato deals this time</p>
          )}
        </article>

        <article className={`summary__card summary__card--swiggy ${swiggy ? '' : 'is-empty'}`}>
          <p className="summary__platform">{platformLabel('swiggy')}</p>
          {swiggy ? (
            <>
              <p className="summary__price">{formatPrice(swiggy.price)}</p>
              <p className="summary__rest">Lowest near {swiggy.restaurant_name}</p>
            </>
          ) : (
            <p className="summary__rest">No Swiggy deals this time</p>
          )}
        </article>
      </div>

      {(succeeded.length > 0 || failed.length > 0) && (
        <p className="summary__status">
          {succeeded.length > 0 && (
            <span>Live from {succeeded.map(platformLabel).join(' + ')}</span>
          )}
          {failed.length > 0 && (
            <span className="summary__failed">
              {' '}
              · {failed.map((f) => platformLabel(f.platform)).join(', ')} unavailable
            </span>
          )}
        </p>
      )}
    </section>
  );
}
