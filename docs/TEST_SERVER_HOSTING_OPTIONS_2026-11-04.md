# Test Server Hosting Options (App Service Container vs. Alternatives)

**Date:** 2026-11-04
**Question:** Can we run the whole application in an Azure App Service container, and run a separate test version alongside production? How would the services work, given we have a PostgreSQL server running? Are there other solutions?

---

## 1. What we have today

- **One Node 20 / Fastify API** (`apps/api`), run by PM2 (`convixx-api`, port 8080) on the Azure VM `20.219.26.128`. The admin pages and the simulator pages come from that same process.
- **PostgreSQL with pgvector** (`CREATE EXTENSION vector` in `infra/postgres/init.sql`).
- **Long-lived WebSockets** for the Exotel and Vodafone voicebots, and for Cartesia and Sarvam speech.
- **Files on local disk**: campaign uploads go to `apps/api/uploads/campaigns`.
- **A risk already present:** the local `apps/api/.env` points at the production database. Any "test" run today writes to production data.

---

## 2. Option A: Azure App Service (container) with a production slot and a test slot

### How it would work

- Build one Docker image of the API and push it to Azure Container Registry (ACR).
- App Service runs the container. PM2 goes away, because App Service restarts the container if it crashes.
- Set `WEBSITES_PORT=8080`, add a health check, and send logs to Log Stream or Application Insights.
- For a test server, use **deployment slots**, not a second app:
  - Production slot plus a `test` slot (`convixx-test.azurewebsites.net` or `test.convixx.in`) on the same plan.
  - Mark each slot's `DATABASE_URL`, telephony URLs and keys as **slot-specific** so they never swap.
  - Test a build in the test slot, then swap it to production with no downtime.

### PostgreSQL

PostgreSQL does **not** go into the container. App Service storage isn't meant for a database. Two choices:

1. **Keep Postgres where it runs now.** The app would have to reach it over VNet integration or a firewall rule. That works, but it's awkward.
2. **Move it to Azure Database for PostgreSQL Flexible Server**, which supports pgvector. This is the cleaner choice.

Either way, create a **separate test database** (for example `convixx_test`) on the same server. Test must never use the production database.

### Things to watch with this app

- **WebSockets:** they have to be switched on in App Service. Telephony providers also need a stable public `wss://` URL, so use a custom domain with a managed certificate.
- **IP allowlisting:** if Vodafone or Exotel allowlist IP addresses, App Service outbound IPs are shared and can change. The Vodafone WebSocket research doc (`docs/VODAFONE_WEBSOCKET_NOT_CONNECTING_RESEARCH_2026-09-18.md`) may run into this.
- **Uploads:** the container's disk is wiped on restart, so `uploads/` has to move to Azure Files (mounted) or Blob Storage.
- **Test calling real customers:** the test slot must not run real outbound campaigns or receive production telephony webhooks. Give it its own test numbers and callback URLs.
- **Cost:** slots need the Standard (S1) tier or higher. With the registry, that's roughly $75/month or more.

---

## 3. Option B: a second instance on the same VM (cheapest, quick to set up)

- Make a second checkout, for example `/var/www/test_module`, on a test branch.
- Give it its own `.env` pointing at a `convixx_test` database, run it as a second PM2 process on port 8081, and route `test.convixx.in` to it through nginx.
- Docker Compose on the VM can do the same job with less risk of the two instances interfering.

| Pros | Cons |
|---|---|
| No extra cost | Test shares CPU and RAM with production |
| Telephony and IP setup unchanged | A heavy test can slow production down |
| No code changes | |

---

## 4. Other options

- **A second small VM** (B2s, around $30–40/month) as a copy of production. Test is fully isolated, and the setup is the same one we already know.
- **Azure Container Apps:** each version runs as a separate revision, a test copy can shut down completely when idle so it costs almost nothing, and WebSockets work. A good fit for containers without paying for an App Service plan.

---

## 5. Comparison

| | App Service + slots | Second instance on VM | Second VM | Container Apps |
|---|---|---|---|---|
| Approx. cost | ~$75+/month | $0 | ~$30–40/month | Low (test can be idle at $0) |
| Setup effort | Medium–high (Dockerfile, storage, networking) | Low | Low | Medium |
| Isolation from prod | Shared plan, separate slot | Shared machine | Full | Full |
| Zero-downtime swap | Yes | No | No | Yes (revisions) |
| Code changes | Dockerfile, uploads storage | None | None | Dockerfile, uploads storage |
| Stable outbound IP | No (shared, can change) | Yes | Yes | Needs NAT gateway |

---

## 6. Recommendation

1. **Now:** use Option B (second PM2 process plus a separate test database) or a second small VM. This gets a test server running in a day without rebuilding anything.
2. **In every case:** create a separate test database and stop the local `.env` from pointing at production. Of everything here, this is the most important.
3. **Later:** for managed hosting, put the API in a container, move Postgres to Flexible Server, and use App Service slots or Container Apps. The app is already a single stateless process apart from `uploads/`, so the move is mostly the Dockerfile, the storage for uploads, and moving settings into Azure.

### Open question

It isn't confirmed yet whether Postgres runs on the same VM or on a separate server. That changes how much work Option A's networking takes.
