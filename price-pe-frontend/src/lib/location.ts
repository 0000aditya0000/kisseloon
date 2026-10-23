import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import type { UserLocation } from '../types';

const CITY_ALIASES: Array<{ match: RegExp; slug: string; label: string }> = [
  { match: /bengaluru|bangalore/i, slug: 'bangalore', label: 'Bangalore' },
  { match: /mumbai|bombay/i, slug: 'mumbai', label: 'Mumbai' },
  { match: /\bpune\b/i, slug: 'pune', label: 'Pune' },
  { match: /hyderabad/i, slug: 'hyderabad', label: 'Hyderabad' },
  { match: /chennai|madras/i, slug: 'chennai', label: 'Chennai' },
  { match: /kolkata|calcutta/i, slug: 'kolkata', label: 'Kolkata' },
  { match: /noida|greater noida/i, slug: 'noida', label: 'Noida' },
  { match: /gurgaon|gurugram/i, slug: 'gurgaon', label: 'Gurugram' },
  { match: /ghaziabad/i, slug: 'ghaziabad', label: 'Ghaziabad' },
  { match: /faridabad/i, slug: 'faridabad', label: 'Faridabad' },
  { match: /new delhi|delhi|ncr/i, slug: 'delhi', label: 'Delhi' },
];

const FALLBACK: UserLocation = {
  citySlug: 'bangalore',
  label: 'Bangalore',
  source: 'fallback',
};

export function resolveCityFromText(text: string): UserLocation | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  for (const city of CITY_ALIASES) {
    if (city.match.test(trimmed)) {
      return { citySlug: city.slug, label: city.label, source: 'manual' };
    }
  }

  // Free-text area → slugify for API (e.g. "Koramangala")
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  if (!slug) return null;

  return {
    citySlug: slug,
    label: trimmed
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' '),
    source: 'manual',
  };
}

async function reverseGeocode(lat: number, lng: number): Promise<UserLocation | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      city?: string;
      locality?: string;
      principalSubdivision?: string;
    };

    const haystack = [data.city, data.locality, data.principalSubdivision]
      .filter(Boolean)
      .join(' ');

    const matched = resolveCityFromText(haystack);
    if (matched) {
      return { ...matched, source: 'gps' };
    }

    if (data.city) {
      return {
        citySlug: data.city.toLowerCase().replace(/\s+/g, '-'),
        label: data.city,
        source: 'gps',
      };
    }
  } catch {
    // ignore geocode failures
  }
  return null;
}

async function getCoordinates(): Promise<{ lat: number; lng: number } | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const permission = await Geolocation.requestPermissions();
      if (permission.location === 'denied') {
        return null;
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 12_000,
      });
      return {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
    }

    if (!('geolocation' in navigator)) {
      return null;
    }

    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 60_000,
      });
    });

    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    };
  } catch {
    return null;
  }
}

/** Detect city from device GPS; falls back to Bangalore. */
export async function detectUserLocation(): Promise<UserLocation> {
  const coords = await getCoordinates();
  if (!coords) {
    return FALLBACK;
  }

  const resolved = await reverseGeocode(coords.lat, coords.lng);
  return resolved ?? FALLBACK;
}

export const POPULAR_CITIES = [
  { slug: 'bangalore', label: 'Bangalore' },
  { slug: 'mumbai', label: 'Mumbai' },
  { slug: 'delhi', label: 'Delhi' },
  { slug: 'noida', label: 'Noida' },
  { slug: 'gurgaon', label: 'Gurugram' },
  { slug: 'hyderabad', label: 'Hyderabad' },
  { slug: 'pune', label: 'Pune' },
  { slug: 'chennai', label: 'Chennai' },
] as const;
