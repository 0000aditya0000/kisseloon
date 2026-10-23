import {
  formatPrice,
  formatRating,
  platformLabel,
  sortByPrice,
} from '../lib/format';
import type { ComparisonProduct } from '../types';

interface ResultListProps {
  items: ComparisonProduct[];
}

function VegDot({ isVeg }: { isVeg: boolean }) {
  return (
    <span
      className={`veg-dot ${isVeg ? 'veg-dot--veg' : 'veg-dot--non'}`}
      title={isVeg ? 'Vegetarian' : 'Non-vegetarian'}
      aria-label={isVeg ? 'Vegetarian' : 'Non-vegetarian'}
    />
  );
}

export function ResultList({ items }: ResultListProps) {
  const sorted = sortByPrice(items);

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <h3>No matching dishes</h3>
        <p>Try another dish name or switch city.</p>
      </div>
    );
  }

  return (
    <ul className="result-list">
      {sorted.map((item, index) => (
        <li
          key={`${item.platform}-${item.platform_id}-${item.id}`}
          className="result-item"
          style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
        >
          <div className="result-item__media">
            <img
              src={item.image_url}
              alt=""
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src =
                  'https://via.placeholder.com/160x160?text=Dish';
              }}
            />
          </div>

          <div className="result-item__body">
            <div className="result-item__top">
              <span className={`platform-badge platform-badge--${item.platform.toLowerCase()}`}>
                {platformLabel(item.platform)}
              </span>
              <VegDot isVeg={item.is_veg} />
            </div>

            <h3 className="result-item__name">{item.name}</h3>
            <p className="result-item__restaurant">{item.restaurant_name}</p>

            <div className="result-item__meta">
              <span>{formatRating(item.rating)} ★</span>
              <span>·</span>
              <span>
                {item.delivery_time_min > 0 ? `${item.delivery_time_min} min` : '—'}
              </span>
            </div>
          </div>

          <div className="result-item__aside">
            <p className="result-item__price">{formatPrice(item.price)}</p>
            {item.deep_link ? (
              <a
                className="result-item__link"
                href={item.deep_link}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
