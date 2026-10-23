# PricePe Frontend

Hybrid web + mobile shell for PricePe. Built with **Vite + React + TypeScript** and **Capacitor**, so the same UI runs as:

- Website (desktop / mobile browser)
- Android app (`npx cap add android`)
- iOS app (`npx cap add ios`)

No login for now — detect location, enter a dish, compare Zomato vs Swiggy via the PricePe backend.

## Quick start

```bash
cd price-pe-frontend
npm install
cp .env.example .env   # if needed
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Backend should be running at `http://localhost:3000` (see `price-pe-backend`).

## Environment

```env
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

For a physical phone testing against your PC, use your LAN IP, e.g. `http://192.168.1.10:3000/api/v1`.

## Features

- Auto location via browser / Capacitor Geolocation + reverse geocode
- Manual city picker fallback
- Dish search → `GET /api/v1/products/search?q=&location=`
- Lowest-price summary per platform
- Sorted offer list with deep links

## Mobile (Capacitor)

```bash
npm run build
npx cap add android   # once
npx cap add ios       # once (macOS)
npm run cap:sync
npm run cap:android   # or cap:ios
```

## Notes

- Scrapes can take up to ~3 minutes; the UI shows a loading state.
- Zomato dish titles are often generic (`Biryani`) while Swiggy uses menu-item names — compare by restaurant + price, not name alone.
