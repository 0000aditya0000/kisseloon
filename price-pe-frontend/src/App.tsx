import { useEffect, useRef, useState, useTransition } from 'react';
import { LocationBar } from './components/LocationBar';
import { PlatformSummary } from './components/PlatformSummary';
import { ResultList } from './components/ResultList';
import { SearchForm } from './components/SearchForm';
import { searchProducts } from './lib/api';
import { detectUserLocation } from './lib/location';
import type { ComparisonProduct, SearchMeta, UserLocation } from './types';

type ViewState = 'idle' | 'loading' | 'ready' | 'error';

export default function App() {
  const [location, setLocation] = useState<UserLocation | null>(null);
  const [detectingLocation, setDetectingLocation] = useState(true);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ComparisonProduct[]>([]);
  const [meta, setMeta] = useState<SearchMeta | undefined>();
  const [view, setView] = useState<ViewState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);

  const loadLocation = async () => {
    setDetectingLocation(true);
    try {
      const detected = await detectUserLocation();
      setLocation(detected);
    } finally {
      setDetectingLocation(false);
    }
  };

  useEffect(() => {
    void loadLocation();
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleSearch = (dish: string) => {
    if (!location) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setQuery(dish);
    setView('loading');
    setError(null);

    void (async () => {
      try {
        const result = await searchProducts(dish, location.citySlug, controller.signal);
        startTransition(() => {
          setItems(result.data);
          setMeta(result.meta);
          setView('ready');
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message || 'Something went wrong while comparing prices.');
        setItems([]);
        setMeta(undefined);
        setView('error');
      }
    })();
  };

  return (
    <div className="app-shell">
      <div className="atmosphere" aria-hidden />

      <header className="topbar">
        <p className="brand">PricePe</p>
        <p className="brand-tag">Compare food prices, skip the guesswork</p>
      </header>

      <main className="main">
        <section className="hero">
          <h1 className="hero__title">
            PricePe
            <span className="hero__sub">Same dish. Two apps. Clearer choice.</span>
          </h1>

          <LocationBar
            location={location}
            detecting={detectingLocation}
            onChangeCity={(slug, label) =>
              setLocation({ citySlug: slug, label, source: 'manual' })
            }
            onRefresh={() => void loadLocation()}
          />

          <SearchForm
            disabled={!location || detectingLocation}
            loading={view === 'loading'}
            onSearch={handleSearch}
          />
        </section>

        {view === 'loading' && (
          <section className="loading-panel" aria-live="polite">
            <div className="loading-panel__orb" />
            <h2>Comparing Zomato & Swiggy</h2>
            <p>
              Looking up <strong>{query}</strong> near <strong>{location?.label}</strong>.
              Hang tight — live scrapes can take up to a minute.
            </p>
          </section>
        )}

        {view === 'error' && (
          <section className="error-panel" role="alert">
            <h2>Couldn’t complete this comparison</h2>
            <p>{error}</p>
            <button type="button" className="ghost-btn" onClick={() => query && handleSearch(query)}>
              Try again
            </button>
          </section>
        )}

        {view === 'ready' && (
          <section className="results">
            <PlatformSummary items={items} meta={meta} query={query} />
            <ResultList items={items} />
            <p className="results__note">
              Dish names can differ by app — Zomato often shows a generic dish label while Swiggy
              lists exact menu items. Compare by restaurant and price, not name alone.
            </p>
          </section>
        )}

        {view === 'idle' && (
          <section className="idle-panel">
            <p>Enter a dish above to see live prices from Zomato and Swiggy.</p>
          </section>
        )}
      </main>

      <footer className="footer">
        <span>PricePe</span>
        <span>Web · Android · iOS ready</span>
      </footer>
    </div>
  );
}
