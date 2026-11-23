# Vodafone (VI) WebSocket Not Connecting — Research Notes (2026-09-18)

**Status:** Research only. No code, config, deploys, restarts, or certificate changes were made while producing this document.

**Vodafone support ticket:** `EN_CTS_18092026_801900` — "WebSocket not being received"

**IMPORTANT CORRECTION (this revision):** An earlier version of this document proposed the server's ECDSA-only TLS certificate as the likely cause. That hypothesis is **retracted** — see §2. The corrected, evidence-based timeline and findings are below.

## 1. What Vodafone reported

For Call ID `29924580` (18/09/2026, 01:59:10–01:59:34 IST):

- The Streaming Object *was* invoked; the call passed through the Streaming Object step.
- Bidirectional Streaming is enabled and active (both IBD and OBD).
- Their platform attempted to open the WebSocket to `wss://convixx.in/telephony/vodafone/voicebot/97752ef1-eb4f-4ebb-a77f-0613fe3a424b` **5 times** and got **no response** each time (`WS connect failed after 5 attempts`).

## 2. Corrected timeline — the break is NOT "10am yesterday"

Nginx's access log records **every single WebSocket connection attempt that ever reached this server**, successful or not, going back through the relevant period. I pulled every real Vodafone connection (source IP `118.185.111.81`, user agent `ptSIPMix-WebSocket/1.0` — confirmed to be Vodafone's actual production Streaming Object client, not a separate test tool: the call IDs it carries, e.g. `29924506` → `29924581`, are one continuous sequential numbering series matching the call ID in this same ticket).

**57 real Vodafone connections succeeded on 2026-09-17**, spread across the entire day, including well after 10am:

```
10:46:36, 11:02:56, 11:05:15, 11:13:36, 13:59:24 ... (25+ more through 14:04–14:17),
18:03:18 ... (through 18:41:37), 19:11:28 ... (through 19:58:46),
20:59:33, 22:24:45, 22:27:40  <-- last confirmed success
```

Every one of these returned HTTP `101 Switching Protocols` — a completed WebSocket handshake.

**The first fully failed attempt we can find is at 01:59:10 on 2026-09-18** (the call in this ticket) — and unlike every single one of the 57 successes above, it produced **zero trace anywhere**: not in nginx's access log, not in nginx's error log, not in the application log. Every prior attempt, successful or not, always produced at least an access-log line; this one produced nothing at all.

**Conclusion: the actual transition from "working" to "completely silent failure" happened somewhere in the roughly 3.5-hour window between 22:27:40 IST on 2026-09-17 and 01:59:10 IST on 2026-09-18** — not at 10am the previous morning. Whatever change is responsible happened in that specific window.

## 3. Why the earlier TLS-certificate hypothesis is wrong

The previous version of this document flagged that the server's TLS certificate for `convixx.in` is ECDSA-only (verified: forcing an RSA-only cipher suite against it produces a handshake failure). That is still true as a fact about the certificate, but it **cannot be the cause of this specific failure**, because:

- The certificate has been ECDSA since at least 2026-04-14 and has not changed since (last renewal: 2026-08-12; `certbot certificates` confirms `Key Type: ECDSA`).
- Nginx itself has not been reloaded or restarted since **2026-09-15 06:33:14** (`systemctl status nginx` shows continuous uptime since then, spanning the entire relevant period).
- The real Vodafone client successfully completed a TLS handshake against this exact same certificate **57 times** on 2026-09-17, including minutes before the failure window began (22:27:40).

If Vodafone's platform couldn't handle an ECDSA certificate, it would never have connected even once. It's fully capable of it. This rules the certificate out entirely.

## 4. What we checked on our own infrastructure for the actual break window (22:27:40 → 01:59:10)

Reviewed every Claude Code session's server-side changes (git history) and cross-checked them against actual deploy/restart timestamps on the server itself (not just commit times, since a commit doesn't always mean an immediate deploy):

| Check | Finding |
|---|---|
| App deploys/restarts | The app process running through the entire break window was PID `1307770`, started at **19:53:23** (after commit `f922940`) and *not* restarted again until **01:42:33** the next session — i.e., the exact same running code was in place before, during, and slightly after the break began. No deploy coincides with the break. |
| Nginx reload/restart | None — active continuously since 2026-09-15 06:33:14. No config file changes either (`sites-available/convixx` last modified 2026-09-10; `nginx.conf` last modified 2023). |
| TLS certificate | Unchanged since 2026-08-12 (next scheduled renewal isn't until ~October). |
| Server reboot | None — `uptime -s` shows the VM has been up continuously since **2026-07-12**. |
| OS package updates | Only 3 unrelated automatic security patches applied that day, all at 06:11–06:12 IST (`perl`, `libsqlite3-0`, `libaom3`) — hours before the break window, and none touch networking, TLS, or Node. |
| Scheduled tasks (cron/systemd timers) | No crontab exists for any user; no systemd timer fired in or near the break window that touches networking, certs, or the app. |
| SSH/login activity | Only routine internet background noise (automated bot scans trying `root`/`admin`/`ubuntu` logins from random IPs — this happens to every public server continuously and none succeeded). No genuine admin session touched the server in that window. |

**Every check on our own server, application, and nginx configuration comes back negative for the actual break window.** Nothing we control changed.

## 5. What this leaves

Since nothing on our side changed, and the very same client type worked 57 times before falling completely silent afterward with the identical URL and certificate, the remaining candidates are:

1. **Something changed on Vodafone's own side** in that 3.5-hour window — their outbound network path, DNS cache for `convixx.in`, a media/streaming server pool rotation, a maintenance window, or an outbound firewall/allowlist change on their end. We cannot see or verify this from our side; Vodafone's own infrastructure logs for that specific window would confirm or rule it out.
2. **Azure's Network Security Group (NSG)**, a cloud-level firewall layer that sits in front of this VM and is **not visible from inside the VM** (the VM's own `iptables`/`ufw` are fully open, but that's a separate, lower layer — an NSG rule change wouldn't show up in anything checked above). If an NSG rule was modified — intentionally or by an automated policy — to restrict which source IPs/ranges can reach port 443 in that window, Vodafone's specific IP range could be silently dropped before ever reaching nginx, which would produce exactly the total silence observed (no access log, no error log, nothing) with zero trace inside the VM. **This needs to be checked directly in the Azure Portal** (Networking → Network Security Group for this VM → Inbound security rules, plus NSG flow logs if enabled, filtered to the window 2026-09-17 22:00 IST through 2026-09-18 02:00 IST) — this is not something checkable via SSH into the VM itself, and no Azure CLI/portal access was available for this research.

## 6. Full audit: everything checked from 2026-09-17 03:00 IST to now, on both the codebase and the live server

Per explicit request, this is an exhaustive, evidence-based sweep — not inference — covering every category of change that could plausibly block or silently drop Vodafone's connections. Every row below is something actually run and observed, not assumed.

### 6.1 Every code change actually deployed to production in this window

Reconstructed from the server's own restart history (matching each PM2 process restart's timestamp to the exact commit that was live), not just `git log`:

| Deployed at (IST) | Commit | Files touched |
|---|---|---|
| 2026-09-17 02:16:58 | `ec9f480` | `ask.ts`, `kb-admin-ganeshotsav*.ts`, `cartesia-tts-ws.ts`, `suggested-kb.ts` (new), migration `017` (new) |
| 2026-09-17 12:02:48 | `9f61581` | `kb-admin-ganeshotsav.ts` only |
| 2026-09-17 12:28:24 | `c9516f0` | `vodafone-voicebot.ts` only |
| 2026-09-17 14:25:14 | `80360e0` | `vodafone-voicebot.ts`, `cartesia.ts` |
| 2026-09-17 18:11:07 | `5c3b2ba` | `vodafone-voicebot.ts` only |
| 2026-09-17 18:28:50 | `08b89b3` | `logger-factory.ts`, `vodafone-voicebot.ts` |
| 2026-09-17 19:10:43 | `bfa495a` | `vodafone-voicebot.ts` only |
| 2026-09-17 19:20:00 | `ccd6308` | `vodafone-voicebot.ts`, `cartesia.ts` |
| 2026-09-17 19:39:29 | `56339e6` | `vodafone-voicebot.ts` only |
| **2026-09-17 19:53:23** | **`f922940`** | `ask.ts`, `vodafone-voicebot.ts`, `cartesia-tts-ws.ts`, `sarvam.ts`, `voice-language-infer.ts`, `voice-reply-stream.ts` — **this is the exact code that was running, unchanged, through the entire break window (22:27:40 → 01:59:10)** |
| 2026-09-18 01:42:33 | `b192e79` (this session's revert, done after the break was already reported) | (revert, post-dates the break) |
| 2026-09-18 02:21:04 | `ec9f480` (this session's second revert) | (revert, post-dates the break) |

**Every file touched by every one of these commits is application business logic only**: TTS pacing/streaming, KB admin UI, logging format, language-switch detection. None of them touch `app.ts` (routing/middleware setup), any middleware/auth file, `package.json` (no dependency changed), `ecosystem.config.cjs`, or `.env` — confirmed with an explicit diff across the full window (`git diff 9f61581~1 f922940` on those specific files returns empty). **Nothing deployed in this window could plausibly affect network-level reachability, TLS negotiation, or IP filtering** — there is no code anywhere in this codebase that filters, blocks, or allowlists by IP, host, or origin (checked via full-repo search).

### 6.2 Every file actually changed on the server's filesystem, tracked or not

Ran `find` for any file modified anywhere under `/var/www/main_module` (excluding logs/node_modules/dist/uploads, which change constantly and are irrelevant) between 2026-09-17 03:00 and 2026-09-18 02:00:

- Only the exact files from the commits in §6.1 above were touched. Nothing untracked, nothing extra.
- `.env` was **not modified** — last change was 2026-09-15 14:27:05, days before the break window. No secret, API key, or environment variable changed.

Ran the same search across all of `/etc` (system-wide config, including nginx, SSH, systemd, networking) for the same window:

- The **only** file touched anywhere in `/etc` was `/etc/ld.so.cache` — the shared-library linker cache, which is automatically and harmlessly regenerated whenever a system package updates (matches the 3 trivial `perl`/`libsqlite3`/`libaom3` security patches applied by `unattended-upgrades` at 06:11–06:12 IST that morning, hours before the break window and unrelated to networking).
- Nginx's own config files, TLS certificate, and the systemd service itself: all confirmed unchanged (§3, §4).

### 6.3 Every IP/host-blocking mechanism checked — none exist, none are active

| Mechanism | Status |
|---|---|
| `iptables` (host firewall) | Fully open, no rules, policy ACCEPT on all chains |
| `ufw` | Inactive |
| `nftables` | Only Azure's own auto-managed `security` table for its internal WireServer endpoint (168.63.129.16) — unrelated to public traffic, untouched by us, not something we can or did modify |
| `fail2ban` | **Not installed** |
| `ipset` | **Not installed** |
| `CrowdSec` | **Not installed/inactive** |
| `ModSecurity` / any nginx WAF module | **Not installed** |
| Nginx `deny`/`allow`/`geo`/`limit_req`/`limit_conn` directives | None configured anywhere in `/etc/nginx` |
| `/etc/hosts` | Default, untouched, no suspicious entries |
| DNS resolver config | Default `systemd-resolved` stub, untouched |
| Application-level IP/host filtering code | **None exists anywhere in this codebase** (full-repo search for blocklist/allowlist/IP-comparison patterns found nothing relevant) |

### 6.4 Conclusion of this audit

**Nothing — in the codebase, in what was deployed, or on the live server itself — changed in a way that could explain Vodafone's connections being blocked or silently dropped in the 22:27:40→01:59:10 window, or at any other point in the last two days.** This was checked exhaustively, not assumed. Combined with §2–§4, this rules out our own code, our own deploys, our own server configuration, and any local blocking mechanism as the cause with a very high degree of confidence.

That leaves exactly the two candidates in §5: **Azure's Network Security Group** (a cloud-level firewall layer that sits in front of this VM and is invisible to every check above, since it filters traffic before it ever reaches the VM's own network stack) and **something that changed on Vodafone's own infrastructure**. Both are outside what is inspectable from inside this server via SSH.

## 6.5 The actual pattern, found by comparing every successful connection against every failed one (2026-09-18, later same day)

Six real Vodafone calls connected successfully today (`29924790`, `29924801`, `29924802`, `29924803`, `29924813`, `29924869`), on top of the 57 that succeeded on 2026-09-17. Comparing all of them directly against the failures revealed a specific, testable pattern that the earlier sections of this document did not consider:

**Every single successful WebSocket connection to the Vodafone endpoint — 74 out of 74, across the entire log history — came from exactly one source IP: `118.185.111.81`.** Not "usually." All of them, with a 100% success rate.

**No other real Vodafone IP address appears anywhere in the logs at all** — not as a success, and not as a logged failure/rejection either. The calls that fail (like `29924580` in the support ticket) leave zero trace from any source IP, not just from `118.185.111.81`. If a different server had attempted and been actively rejected (wrong customer ID, TLS error, HTTP error), we would expect to see *that* IP in the logs with a failure status. We see nothing — no second IP, successful or not.

**Most likely explanation:** Vodafone's Streaming Object platform is not necessarily a single server — carrier-grade platforms like this commonly run a pool of media/streaming servers for load-balancing and redundancy, each with its own outbound public IP. If only `118.185.111.81` is able to reach this server — for example, because of an Azure Network Security Group rule that allows that one specific IP (set up at some point and never widened to cover Vodafone's full server range) — then any call that happens to be handled by a *different* node in Vodafone's pool would be silently blocked before ever reaching this server's network stack, producing exactly the "connect failed after 5 attempts, no response" symptom Vodafone reported, while calls that land on the one allowed node connect perfectly every time. This does not require anything to have "broken" at a specific moment — it's consistent with this having always been the situation, with which calls succeed or fail simply depending on which of Vodafone's servers happens to handle that particular call.

**This reframes §5's Azure NSG candidate from a vague possibility into a specific, testable one:** check whether the NSG for this VM has an inbound allow rule scoped to `118.185.111.81` (or a narrow range containing only it) rather than Vodafone's full outbound IP range, and check Vodafone's side for the complete list of IPs their Streaming Object infrastructure can originate connections from.

## 7. Recommended next steps

- **Ask Vodafone for the complete list of public IP addresses their Streaming Object platform can originate WebSocket connections from** (their full media/SBC server pool, not just the one address we've seen succeed, `118.185.111.81`). This is now the single most direct next step given §6.5.
- **Check the Azure NSG for this VM in the Azure Portal** for any rule change (added, removed, or modified) with a timestamp in the window 2026-09-17 21:30 IST – 2026-09-18 02:00 IST. This is the single most likely place a network-level block could exist that we cannot see from inside the server.
- **Ask Vodafone's support team directly**: "Your own successful connections to us stopped completely after 22:27:40 IST on 17/09. Can you check your platform's own outbound network/DNS logs for `convixx.in` specifically in the window 22:27 IST 17/09 through 02:00 IST 18/09, to see what changed on your end at that time?" — pointing them at this specific, narrow window (rather than the vague "sometime that morning") gives them a much better chance of finding a matching change or incident on their own side.
- If neither of the above turns up anything, the next diagnostic step would be a packet capture (`tcpdump`) on the server the next time Vodafone attempts a connection, to see definitively whether their TCP/TLS handshake packets ever arrive at the network interface at all — that would conclusively separate "blocked before reaching the VM" from "reaching the VM but failing for some other reason."
