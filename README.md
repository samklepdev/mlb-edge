# mlb-edge

MLB prop-betting research pipeline + dashboard. Measures whether the model is
**calibrated** and beating the **closing line** — the only honest signals of an
edge. See [HANDOFF.md](./HANDOFF.md) for full state, architecture, and next steps.

```bash
docker compose up -d
npm install
cp .env.example .env
npm run db:migrate
npm run seed:demo     # synthetic data so the dashboard has something to show
npm run web:dev       # http://localhost:3000
```
