# Rebook AI

Bookings, enquiries and rebooking for any business that takes bookings. One Next.js modular
monolith on Supabase Postgres, with correctness (tenant isolation, no double bookings, immutable
attribution) enforced in the database.

- **Run it locally:** [`docs/setup.md`](docs/setup.md)
- **Design:** [`docs/architecture.md`](docs/architecture.md) (System Design v1.0)
- **Build plan and gates:** [`docs/phases.md`](docs/phases.md)
- **Decisions:** [`docs/adr/`](docs/adr/)
- **Rules for contributors and agents:** [`CLAUDE.md`](CLAUDE.md)

Quick start (details and prerequisites in the setup guide):

```sh
nvm install && corepack enable
pnpm install
cp .env.example .env
pnpm db:start     # supabase start + pnpm db:roles
pnpm dev          # http://localhost:3000 → sign up, create a business
```

Sign-in link emails from the local stack land in Mailpit at http://127.0.0.1:54324.
