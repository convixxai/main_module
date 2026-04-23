# Dependency Security Deep-Dive (Appendix B, expanded)

**Repository:** `Convixx/nodejs_main`
**Scope:** `apps/api` dependency tree (175 packages total — 109 prod, 66 dev)
**Audit date:** 2026-04-18
**Source:** `npm audit --json` + `npm ls` dependency tree + advisory database (GHSA)
**Companion file:** `docs/SECURITY_AUDIT_2026-04-18.md`
**Remediation cost summary:** **zero application-code changes**, only `package.json` and `package-lock.json` updates.

---

## 1. At-a-glance

| #  | Package            | Installed version(s)          | Fixed in             | Severity  | CVSS  | Reachable in our runtime? | Real risk to us |
|----|--------------------|-------------------------------|----------------------|-----------|-------|----------------------------|-----------------|
| 1  | `fastify`          | 5.7.4 (direct)                | 5.8.5                | **HIGH**  | 7.5   | Yes — every HTTP request   | **High**        |
| 2  | `@fastify/static`  | 9.0.0 (transitive)            | 9.1.1                | Moderate  | 5.9   | Yes — Swagger UI at `/docs`| Low–Medium      |
| 3  | `minimatch`        | 3.1.3 (dev) + 10.2.2 (prod)   | 3.1.4 / 10.2.5       | **HIGH**  | 7.5   | Partial (see §4)           | Low             |
| 4  | `picomatch`        | 2.3.1 (dev only)              | 2.3.2 / 4.0.4        | **HIGH**  | 7.5   | **No** — dev only          | Negligible      |
| 5  | `brace-expansion`  | 1.1.12 (dev) + 5.0.3 (prod)   | 1.1.13 / 5.0.5       | Moderate  | 6.5   | Same as `minimatch`        | Low             |
| 6  | `yaml`             | 2.8.2 (transitive)            | 2.8.3                | Moderate  | 4.3   | Yes — OpenAPI spec parse   | Low             |

All six are listed as `fixAvailable: true` by `npm`. Applying the fixes requires **no source-code changes** — this is the important point to tell the team. It is a `package.json` / `package-lock.json` bump and a rebuild.

Rollout effort estimate:

- Time to fix: **~30 minutes** (including a lockfile refresh, CI build, and smoke test).
- Application files touched: **0**.
- Config files touched: **2** (`apps/api/package.json`, `apps/api/package-lock.json`).

---

## 2. Dependency tree that surfaced these findings

`npm ls` output (condensed) showing exactly *why* each vulnerable package is in our tree:

```
api@1.0.0
├── @fastify/cors@11.2.0
├── @fastify/multipart@9.4.0
├── @fastify/swagger@9.7.0
│   └── yaml@2.8.2                               ← 2.8.2  (VULN)
├── @fastify/swagger-ui@5.2.5
│   ├── @fastify/static@9.0.0                    ← 9.0.0  (VULN)
│   │   └── glob@13.0.6
│   │       └── minimatch@10.2.2                 ← 10.2.2 (VULN)
│   │           └── brace-expansion@5.0.3        ← 5.0.3  (VULN)
│   └── yaml@2.8.2 (deduped)
├── @fastify/websocket@11.2.0
├── fastify@5.7.4                                ← 5.7.4  (VULN — direct)
└── ts-node-dev@2.0.0                            (DEV only)
    ├── chokidar@3.6.0
    │   ├── anymatch@3.1.3
    │   │   └── picomatch@2.3.1                  ← 2.3.1  (VULN — dev only)
    │   └── readdirp@3.6.0
    │       └── picomatch@2.3.1 (deduped)
    └── rimraf@2.7.1
        └── glob@7.2.3
            └── minimatch@3.1.3                  ← 3.1.3  (VULN — dev only)
                └── brace-expansion@1.1.12       ← 1.1.12 (VULN — dev only)
```

Key observations:

- Only `fastify` is a **direct** dependency. Everything else is transitive.
- `picomatch` and half of `minimatch` / `brace-expansion` come in only through **`ts-node-dev`** which we use as a dev script (`npm run dev`). In production we run `node dist/index.js` via PM2 (`ecosystem.config.cjs`) — these never load into the running process. That sharply reduces real risk.
- The Swagger UI stack (`@fastify/swagger-ui` → `@fastify/static` → `glob` → `minimatch` → `brace-expansion`) is the only production path that pulls the other half of the vulnerable chain.

---

## 3. Per-finding details

For each package: what the vulnerability is, where it is reachable in *our* code, the CVSS, the realistic attack scenario, the upgrade target, and the precautions we can take even before upgrading.

### 3.1 `fastify` 5.7.4 → 5.8.5 — **HIGH**

**Direct dependency.** Powers every HTTP / WS route — every file under `apps/api/src/routes/**`.

Three advisories apply simultaneously:

#### 3.1.1 GHSA-247c-9743-5963 — Body Schema Validation Bypass via leading space in `Content-Type` (HIGH, CVSS 7.5)

- Fastify parses the `Content-Type` header to select a body parser. A request with a *leading whitespace* (`" application/json"`) bypasses the subtype match, which in turn bypasses Fastify's body schema validation (our Zod-backed `safeParse` *runs on the already-parsed body*, so this is still partially caught — but the raw-body parser that feeds Zod can be skipped or a different parser selected, resulting in `request.body` being `null` / a string).
- **Where we are exposed:**
  - `POST /customers`, `POST /customers/:id/api-key`, `PUT /customers/:id`, `PUT /customers/:id/exotel-settings`, `POST /agents`, `PUT /agents/:id`, `POST /kb/upload`, `PUT /kb/entries/:id`, `POST /ask`, `POST /voice/text-to-speech`, `PATCH /settings/rag`.
  - Any handler that calls `zodSchema.safeParse(request.body)` and treats `!success` as "input rejected" can be tricked into receiving `undefined` and returning a stable 400 — but with combined use of routes that *don't* validate (none currently, but future), this becomes a real bypass.
- **Attack scenario:** An attacker sends `Content-Type: " application/json"` (leading space) to an endpoint that trusts a content-type-level guard in a future version of the code — they can smuggle an unvalidated body.

#### 3.1.2 GHSA-444r-cwp2-x5xf — `request.protocol` / `request.host` spoofable via `X-Forwarded-*` (MODERATE, CVSS 6.1)

- Without an explicit `trustProxy` configuration (which we do **not** set in `apps/api/src/app.ts`), Fastify still reads `X-Forwarded-*` in some code paths. Any caller can set `X-Forwarded-Proto: https` and `X-Forwarded-Host: evil.com`.
- **Where we are exposed:**
  - `apps/api/src/services/exotel-voice-urls.ts` → `voicebotUrlsForCustomer(customerId, request)` uses `request.hostname`. With spoofing, an attacker can poison the `voicebot_wss_url` returned from `GET/PUT /customers/:id/exotel-settings` and `/exotel/voicebot/bootstrap/:customerId`. If an admin copies this value into Exotel, calls route to the attacker's domain.
  - `apps/api/src/plugins/request-logging.ts` logs `request.ip`. Spoofing skews logs and will skew any future rate limit keyed on IP.
- **Attack scenario:** Chained with finding §3.2 of the main report (unauthenticated bootstrap endpoint), this gives a one-shot persistent redirect of voice traffic.

#### 3.1.3 GHSA-573f-x89g-hqp9 — Missing end anchor in `subtypeNameReg` (MODERATE, CVSS 5.3)

- A malformed `Content-Type` can pass Fastify's validation when it shouldn't (`application/json; charset=utf-8whatever-attacker-appends`). Impact is integrity of parsing decisions.

#### Fix

- `npm i fastify@^5.8.5` (satisfied by our current `^5.7.4` range — a lockfile refresh is enough).
- After upgrade, **also** set `trustProxy` explicitly in `buildApp`:

  ```ts
  const app = Fastify({
    loggerInstance: createRootLogger(),
    disableRequestLogging: true,
    trustProxy: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], // your LB CIDR only
  });
  ```

#### Safer alternatives if we ever want to switch

- **Not recommended to replace Fastify.** Fastify is still actively maintained and the fixed versions ship quickly. The cost of switching to Koa / Hono / Express is weeks of engineering and introduces more risk than the CVEs themselves.
- Known alternative frameworks for comparison only: Hono (lightweight, edge-friendly), NestJS (opinionated), Koa (minimal). None would materially reduce our attack surface versus patched Fastify.

#### Precautions available **without** the upgrade

- Put the LB / reverse proxy (nginx / Cloudfront / Caddy) in front of Fastify and strip/reset `X-Forwarded-*` on the way in so Fastify never sees attacker-supplied values.
- Reject requests whose `Content-Type` doesn't exactly match `application/json` / `multipart/form-data; boundary=…` with a pre-parsing hook (`app.addHook('onRequest', …)`). Non-invasive, ~15 lines of code.
- **Code changes required just to apply the upgrade: 0. With the additional hardening above: ~15 lines, only in `app.ts`.**

---

### 3.2 `@fastify/static` 9.0.0 → 9.1.1 — **Moderate**

**Transitive** — pulled in by `@fastify/swagger-ui@5.2.5` to serve the Swagger UI assets under `/docs`.

Two advisories:

#### 3.2.1 GHSA-pr96-94w5-mx2h — Path traversal in directory listing (Moderate, CVSS 5.3)

- When `index: false` + `list: true` is used, encoded `..` segments let a caller walk outside `root`.
- **We do not use directory listing** — `@fastify/swagger-ui` enables only a fixed set of asset paths, so this specific advisory is **not directly exploitable** in our app.

#### 3.2.2 GHSA-x428-ghpx-8j92 — Route guard bypass via encoded path separators (Moderate, CVSS 5.9)

- Encoded `%2F` / `%5C` in URLs can bypass `onSend` / `preHandler` guards that check the decoded path.
- **Reachable in our app?** Only if we ever add a `preHandler` gate on `/docs`. Currently `/docs` has *no* `preHandler`, so there's nothing to bypass. The risk materialises the moment we do §3.14 of the main audit (gate Swagger behind admin auth) — if we add that on top of a vulnerable `@fastify/static`, attackers can bypass the gate.

#### Fix

- `@fastify/swagger-ui@5.2.5` pins `@fastify/static@9.0.0` as its resolved version, but the declared range allows `^9.0.0`. The safest way to apply the fix without waiting for upstream is an npm `overrides` block in `apps/api/package.json`:

  ```jsonc
  {
    "overrides": {
      "@fastify/static": "^9.1.1"
    }
  }
  ```

  Then `npm install`. This is the **only** place where a `package.json` edit is needed for this finding.

#### Alternatives / precautions

- If we decide Swagger UI is not needed in production at all (see main audit §3.14), removing `@fastify/swagger-ui` drops `@fastify/static`, `glob`, `minimatch`, `brace-expansion` and `yaml` from the prod tree in one go. This is a **high-impact, low-cost** step:

  - Remove import: `registerSwagger(app)` from `app.ts`.
  - Remove deps: `@fastify/swagger`, `@fastify/swagger-ui`.
  - Remove `apps/api/src/plugins/swagger.ts`, `apps/api/src/config/swagger.ts`.
  - Keep the OpenAPI JSON at `apps/api/spec/openapi.json` and serve it internally only.
  - **Lines of code removed:** ~80. **Lines added:** 0.

- Or keep Swagger only in non-production builds by registering it behind `if (process.env.NODE_ENV !== 'production')`.

---

### 3.3 `minimatch` 3.1.3 + 10.2.2 → 3.1.4 / 10.2.5 — **HIGH**

Two concurrent versions in the tree:

- `3.1.3` pulled in via `ts-node-dev → rimraf@2.7.1 → glob@7.2.3 → minimatch@3.1.3` — **DEV only**.
- `10.2.2` pulled in via `@fastify/swagger-ui → @fastify/static → glob@13 → minimatch@10.2.2` — **PROD**.

Two advisories:

- **GHSA-7r86-cg39-jmmj** — combinatorial backtracking via multiple non-adjacent `GLOBSTAR` segments (HIGH, CVSS 7.5).
- **GHSA-23c5-xmqv-rm74** — nested `*()` extglobs → catastrophic backtracking ReDoS (HIGH, CVSS 7.5).

#### Where reachable?

- `minimatch` is called by `@fastify/static` internally to decide whether a request's resolved path matches the configured allow-list. In the current `@fastify/swagger-ui` integration the pattern is fixed at server-start, and *user input does not flow into `minimatch.makeRe()`*. In other words, the ReDoS vector requires the **pattern** (not the **string**) to be attacker-controlled, which is not the case here.
- Therefore, even though the CVSS is HIGH, **our exploitation surface is near-zero**. Keep the upgrade anyway for compliance and defence-in-depth.

#### Fix

- Covered automatically by the `@fastify/static@^9.1.1` override above for the prod copy.
- The dev copy (via `rimraf@2` → `glob@7`) goes away as soon as we upgrade `ts-node-dev` (see §3.4).

#### Alternatives

- Replace `minimatch` with `picomatch` at the glob layer — not something we control directly because we don't use glob matching ourselves. No action required at our level.

---

### 3.4 `picomatch` 2.3.1 → 4.0.4 — **HIGH** (but dev-only)

**Transitive, DEV only.** Used by `chokidar` which is used by `ts-node-dev`.

Two advisories:

- **GHSA-c2c7-rcm5-vvqj** — ReDoS via extglob quantifiers (HIGH, CVSS 7.5).
- **GHSA-3v7f-55p6-f55p** — method injection in POSIX character classes (Moderate, CVSS 5.3).

#### Where reachable?

- `ts-node-dev` runs only during `npm run dev` on developer laptops. Production is built by `npm run build` (which uses `tsc`, not `ts-node-dev`) and started by `node dist/index.js` via PM2. **No path from user input → `picomatch` exists in production.**
- Residual risk: a malicious NPM file or repository could trigger the ReDoS in a developer's watch process, causing `ts-node-dev` to hang. That is a developer-productivity issue, not a production security issue.

#### Fix

- Upgrade `ts-node-dev` (EOL; consider replacement) or `overrides` at the top-level:

  ```jsonc
  {
    "overrides": {
      "picomatch": "^4.0.4"
    }
  }
  ```

#### Safer alternatives for the **dev runner itself**

`ts-node-dev` hasn't been actively maintained since 2022 and is the primary reason several dev-only CVEs remain. Recommended modern alternatives:

| Tool                    | Pros                                               | Switch cost                                    |
|-------------------------|----------------------------------------------------|------------------------------------------------|
| **`tsx`**               | Fast, actively maintained, drop-in replacement     | Replace `ts-node-dev --respawn --transpile-only src/index.ts` with `tsx watch src/index.ts` — 1 line in `package.json` |
| **`node --watch` + `tsx`** | Uses built-in Node watch (Node 20+)             | Same — 1 line                                  |
| **`nodemon` + `ts-node`** | Mature but slower                                 | 2 lines                                        |
| **`tsup --watch` + node** | Pre-builds; closer to prod runtime              | A bit more setup (~5 lines of config)          |

#### Effort

- `npm remove ts-node-dev && npm i -D tsx`
- Change `package.json` script: `"dev": "tsx watch src/index.ts"`.
- **0 source files touched.**

---

### 3.5 `brace-expansion` 1.1.12 + 5.0.3 → 1.1.13 / 5.0.5 — Moderate

- **GHSA-f886-m6hf-6m8v** — zero-step sequence (`{1..1..0}`) causes process hang / memory exhaustion (CVSS 6.5).
- Same distribution as `minimatch`: one copy dev, one prod. Reachability mirrors `minimatch` exactly.
- **Fix:** included in the upgrades above. No direct action.

---

### 3.6 `yaml` 2.8.2 → 2.8.3 — Moderate

**Transitive** — pulled by `@fastify/swagger` and `@fastify/swagger-ui` to read our OpenAPI spec.

- **GHSA-48c2-rrv3-qjmp** — Stack overflow via deeply nested YAML collections (CVSS 4.3).

#### Where reachable?

- We currently load `spec/openapi.json` (**JSON**, not YAML) in `apps/api/src/plugins/swagger.ts`:

  ```7:15:apps/api/src/plugins/swagger.ts
  export async function registerSwagger(app: FastifyInstance) {
    const specPath = path.join(process.cwd(), "spec", "openapi.json");
    const altPath = path.join(__dirname, "..", "..", "spec", "openapi.json");
    const resolvedPath = fs.existsSync(specPath) ? specPath : altPath;
  ```

- The YAML parser is still loaded by `@fastify/swagger` at init, but with no user-controlled YAML input, the stack-overflow vector is **not reachable from the network** in our app. The only way it fires is if someone places a malicious YAML into the repo — at which point we already have bigger problems.
- Remaining risk: if we ever switch `specPath` to a `.yaml` file and expose it via another endpoint, the advisory becomes relevant.

#### Fix

- npm overrides block:

  ```jsonc
  { "overrides": { "yaml": "^2.8.3" } }
  ```

#### Safer alternative

- For future YAML parsing prefer `yaml` (latest) with the `maxAliasCount` / `maxRefCount` safety options, or `js-yaml` with `FAILSAFE_SCHEMA`. Avoid `eval`-style YAML (custom tags) from untrusted sources.

---

## 4. Production vs development exposure matrix

```
                     │  Loaded in prod?  │  User-input reachable?  │  Net risk
 fastify@5.7.4       │        Yes        │          Yes            │  HIGH
 @fastify/static@9.0 │        Yes        │ Only via /docs assets   │  Low–Med
 yaml@2.8.2          │        Yes        │          No             │  Low
 minimatch@10.2.2    │        Yes        │          No             │  Low
 brace-expansion@5   │        Yes        │          No             │  Low
 minimatch@3.1.3     │         No (dev)  │          N/A            │  Negligible
 brace-expansion@1   │         No (dev)  │          N/A            │  Negligible
 picomatch@2.3.1     │         No (dev)  │          N/A            │  Negligible
```

**Interpretation:** Of the 6 findings, realistically only **one** (`fastify`) directly endangers the running service today. The other five are either dev-only or sit behind a layer that doesn't accept attacker-controlled input. However — all are trivially fixable, so patch them all.

---

## 5. Fix plan

A single PR can close every finding. Proposed change-set (no source files touched):

### 5.1 `apps/api/package.json` diff (proposed, not applied)

```jsonc
{
  "name": "api",
  "version": "1.0.0",
  // ...
  "dependencies": {
    "@fastify/cors": "^11.2.0",
    "@fastify/multipart": "^9.4.0",
    "@fastify/swagger": "^9.7.0",
    "@fastify/swagger-ui": "^5.2.5",
    "@fastify/websocket": "^11.2.0",
    "crypto-random-string": "^5.0.0",
    "dotenv": "^17.3.1",
    "fastify": "^5.8.5",            // was ^5.7.4
    "openai": "^6.22.0",
    "pg": "^8.18.0",
    "pino": "^10.3.1",
    "uuid": "^13.0.0",
    "ws": "^8.20.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^25.3.0",
    "@types/pg": "^8.16.0",
    "@types/uuid": "^10.0.0",
    "@types/ws": "^8.18.1",
    "tsx": "^4.19.2",               // added, replaces ts-node-dev
    "typescript": "^5.9.3"
    // "ts-node-dev" removed
  },
  "overrides": {
    "@fastify/static": "^9.1.1",
    "yaml": "^2.8.3"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts", // was: "ts-node-dev --respawn --transpile-only src/index.ts"
    // other scripts unchanged
  }
}
```

### 5.2 Commands to run

```
cd apps/api
rm -rf node_modules
npm install        # picks up new versions + overrides
npm audit          # expect: found 0 vulnerabilities
npm run build      # verify TS still compiles
npm run dev        # verify tsx works locally
pm2 restart convixx-api   # in prod after deploy
```

### 5.3 Lines of source code changed

`0`. All changes live in `package.json` and `package-lock.json`.

If we additionally apply the **recommended defence-in-depth** fixes (not required to close the CVEs, but strongly advised):

| Hardening step                                      | File                                      | ~LoC |
|-----------------------------------------------------|-------------------------------------------|------|
| Set `trustProxy` on Fastify                         | `apps/api/src/app.ts`                     |   1  |
| Strict `Content-Type` guard hook                    | `apps/api/src/app.ts` or a new plugin     |  15  |
| Gate `/docs` behind admin auth                      | `apps/api/src/plugins/swagger.ts`         |   3  |
| Remove Swagger UI from prod entirely (alternative)  | delete 2 files + edit `app.ts`            | −80  |
| Force reverse proxy to strip `X-Forwarded-*`        | nginx / ALB config (outside repo)         |   2  |

---

## 6. Why we should still upgrade even though "real risk is low for most"

1. **Compliance posture.** Any future SOC 2 / ISO 27001 / pen-test report will flag a HIGH open on `npm audit`. It's cheaper to close six findings with a lockfile refresh than to argue each one.
2. **Transitive chains evolve.** Today `minimatch` receives no user input from us. Tomorrow a new plugin (say a future `@fastify/static` config, a log-parser, or a CI tool) may pipe user input through the same library. Patched-by-default is the cheapest way to avoid that drift.
3. **Dev-time exploitation still matters.** A `picomatch`/`minimatch` ReDoS that hangs a developer's `ts-node-dev` watcher is an IDE-productivity nightmare during a targeted supply-chain attack.
4. **CVSS trend.** Fastify in particular is releasing ~monthly security fixes. Running `5.7.4` now means we'll be far behind by the next audit. Stay within one minor of `latest`.

---

## 7. Ongoing controls (recommended)

None of these involve application code changes either — they're CI/pipeline additions:

- **GitHub Dependabot** (enable in repo settings) — daily alerts + automatic fix PRs.
- **`npm audit --audit-level=high` as a CI gate** (`.github/workflows/*.yml`) — PRs blocked on new HIGH findings.
- **`npm outdated` weekly report** — informational; catches deps that are current-but-aging.
- **`gitleaks` / `trufflehog`** — scan every commit for accidentally-leaked secrets (see main report §3.1).
- **`osv-scanner`** or **Snyk Open Source** — cross-checks against Google OSV DB in addition to GHSA.
- **Container / runtime scan (Trivy, Grype)** — if we package as Docker.
- **Renovate** as an alternative to Dependabot — more granular grouping / schedule.

---

## 8. Frequently asked questions

**Q. Do I need to change any application code to fix the CVEs?**
No. All six findings are resolved by editing `apps/api/package.json` (one version bump + two `overrides` entries) and running `npm install`. The lockfile is regenerated; the code is untouched.

**Q. Why do some packages appear twice in the tree (two versions)?**
npm's hoisting keeps separate versions when different parents require incompatible ranges. For `minimatch` / `brace-expansion`, the legacy `3.x` copy is chained under the dev-only `ts-node-dev → rimraf → glob@7` tree, while the modern `10.x` / `5.x` copies are chained under `@fastify/swagger-ui → @fastify/static → glob@13`. Removing `ts-node-dev` (§3.4) eliminates the legacy copies without any override.

**Q. Is any of this actively being exploited in the wild?**
- Fastify's `Content-Type` bypass and `X-Forwarded` spoof have published PoCs — they are being scanned for on public endpoints.
- The ReDoS advisories on `minimatch` / `picomatch` have public proofs but require attacker-controlled patterns (we don't offer that path).
- No worm / kit is known to specifically target our stack, but automated CVE scanners (Shodan, Censys) do fingerprint Fastify header behaviour.

**Q. Are we at risk from the `OpenAI` SDK, `pg`, `pino`, `zod`, `ws`, `dotenv`, `uuid`, `crypto-random-string`?**
None of these appear in the current advisory database at our installed versions. They are listed here for completeness — worth re-scanning on every release.

**Q. What about `ws@8.20.0` (used by `@fastify/websocket` and directly)?**
`ws` has had past DoS CVEs (e.g. `GHSA-3h5v-q93c-6h6q` in 8.17.0). Our `8.20.0` is past the patch. No current advisory applies.

**Q. What does "fixAvailable: true" in `npm audit --json` guarantee?**
It means npm has calculated a non-major upgrade path that resolves the finding without breaking semver. It does NOT cover regressions — always run the build & smoke tests after applying.

---

## 9. Summary for management / stakeholders

- **Status:** 6 open dependency vulnerabilities in `apps/api` (3 HIGH, 3 MODERATE).
- **Blast radius:** 1 finding (`fastify`) directly affects every HTTP request handled by the service. The other 5 are either sandboxed or dev-only.
- **Fix cost:** one small PR, zero source code changes, ~30 min engineering time, ~15 min deploy.
- **Residual risk after patch:** minimal at the dependency layer. Application-level findings (see main report) remain the bigger concern.
- **Recommended follow-up controls:** enable Dependabot + add `npm audit` CI gate; retire `ts-node-dev` in favour of `tsx`; optionally drop Swagger UI from production builds.

---

*No source code was modified during this review. All recommendations above are suggestions — the team is expected to review and apply them through the normal change-control process.*
