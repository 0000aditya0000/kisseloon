import { useState, type FormEvent } from 'react';

interface SearchFormProps {
  disabled?: boolean;
  loading?: boolean;
  initialQuery?: string;
  onSearch: (query: string) => void;
}

export function SearchForm({
  disabled,
  loading,
  initialQuery = '',
  onSearch,
}: SearchFormProps) {
  const [query, setQuery] = useState(initialQuery);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || disabled || loading) return;
    onSearch(trimmed);
  };

  return (
    <form className="search-form" onSubmit={handleSubmit}>
      <label className="search-form__label" htmlFor="dish-query">
        What are you craving?
      </label>
      <div className="search-form__row">
        <input
          id="dish-query"
          className="search-form__input"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Biryani, pizza, paneer butter masala…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled || loading}
        />
        <button
          type="submit"
          className="search-form__submit"
          disabled={disabled || loading || !query.trim()}
        >
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </div>
      <p className="search-form__hint">
        We’ll check Zomato and Swiggy together. This can take up to a minute.
      </p>
    </form>
  );
}
