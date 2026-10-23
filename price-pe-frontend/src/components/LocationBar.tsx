import { POPULAR_CITIES } from '../lib/location';
import type { UserLocation } from '../types';

interface LocationBarProps {
  location: UserLocation | null;
  detecting: boolean;
  onChangeCity: (slug: string, label: string) => void;
  onRefresh: () => void;
}

export function LocationBar({
  location,
  detecting,
  onChangeCity,
  onRefresh,
}: LocationBarProps) {
  return (
    <div className="location-bar">
      <div className="location-bar__status">
        <span className="location-bar__pin" aria-hidden>
          ⌖
        </span>
        <div>
          <p className="location-bar__eyebrow">Delivering near</p>
          <p className="location-bar__city">
            {detecting ? 'Finding your city…' : location?.label || 'Set your city'}
          </p>
        </div>
        <button
          type="button"
          className="location-bar__refresh"
          onClick={onRefresh}
          disabled={detecting}
          aria-label="Refresh location"
        >
          {detecting ? '…' : 'Detect'}
        </button>
      </div>

      <label className="location-bar__select-wrap">
        <span className="sr-only">Choose city</span>
        <select
          className="location-bar__select"
          value={location?.citySlug || ''}
          onChange={(e) => {
            const option = POPULAR_CITIES.find((c) => c.slug === e.target.value);
            if (option) {
              onChangeCity(option.slug, option.label);
            }
          }}
        >
          <option value="" disabled>
            Change city
          </option>
          {POPULAR_CITIES.map((city) => (
            <option key={city.slug} value={city.slug}>
              {city.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
