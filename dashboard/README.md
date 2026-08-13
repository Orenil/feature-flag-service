# feature-flag-service dashboard

Small Next.js admin UI for `feature-flag-service`: flag list, audit history
for the selected flag, and a rollback button that calls the real NestJS API.

See the [repo root README](../README.md) for architecture, full setup
(service + dashboard), and usage examples.

## Quick start

```bash
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:3000
npm run dev                   # http://localhost:3001, requires the service running
```
