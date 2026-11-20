# Amtrak Live — ride-along tracker

Pick the train you're on and follow it: live position on a map, every station with scheduled vs actual times, and the long-dwell stops worth stepping off for a smoke break.

- **No dependencies** — plain Node (`node server.js`), static frontend, no build step.
- Data: [Amtraker v3 API](https://github.com/thecommcraft/Amtraker) (public Amtrak feed mirror), proxied server-side with a 20 s cache.
- Map: OpenStreetMap tiles via Leaflet (CDN), with a no-JS-map fallback.

## Run

```
node server.js        # PORT env optional, default 3000
```

## Deploy (Railway)

Push this repo and create a service from it — Railpack detects `package.json`, start command `node server.js`, listens on `$PORT`.

## Layout

- `server.js` — static file server + `/api/trains`, `/api/stations` proxy with TTL cache and stale-fallback
- `public/` — single-page UI (picker → ride view)
