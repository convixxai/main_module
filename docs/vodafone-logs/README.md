# Vodafone call logs and findings

## `watch-5min-2026-11-07_1556-1601.log`

Read-only capture from the production engine log, 15:56:42 to 16:01:42 IST on 7 Nov 2026, taken while "Main campaign diwali" was running. It contains only these lines: `call routed`, `start event numbers` (the raw `cli`, `dni` and custom parameters VI sent), `customer number unknown`, and `crm-tools`.

In those 5 minutes:

- 38 calls started.
  - 33 arrived on the UCB link: `cli` = our DNI, customer number unknown, filed under the fixed "New Test" `campaign_id`.
  - 5 arrived on the Ganesh link: `cli` = customer, filed under "Main campaign diwali".
- 2 calls were refused on the Ganesh link (the number did not match a pending campaign number, and Ganesh is disabled).
- CRM: 5 saves skipped because the customer number was unknown.

## Findings, 7 Nov 2026 (from the full production log, read-only)

"Main campaign diwali" (engine `3c41d9dd-…`, VI ref 772576, 1,364 numbers) was created through `POST /vodafone/campaigns` at 14:01:04. From 14:00, its calls reach the engine through two different VI streaming setups. Their call IDs are interleaved, so it is the same campaign on the same VI platform.

| | UCB link `/telephony/vodafone/voicebot/4c9a8c38-…` | Ganesh link `/telephony/vodafone/voicebot/97752ef1-…` |
|---|---|---|
| Share of calls, 14:00–16:05 | about 78% (524) | about 22% (158) |
| `cli` | **our DNI** `+919112002517` | **the customer's number** |
| `dni` | `9112002517` | `9112002517` |
| `custom_parameters` | `agentId`, `call_type: outbound`, `campaign: benetton-diwali`, `campaign_id: b5e386f6-…` (fixed, the old "New Test"), `direction: outbound` | none |
| Engine result | Customer number unknown, campaign = "New Test", no CRM save | Customer number known, campaign matched by number = "Main campaign diwali", CRM save works |

VI's streaming manual defines `cli` as the caller number and `dni` as the recipient number. On a campaign call the caller is our DNI, so `cli = our DNI` is VI's normal behaviour. In VI's API doc, the OBD `dni` field is described as "Server CLI which is using to initiate OBD". The customer (B-party) is therefore not guaranteed to be in `cli` or `dni` on OBD calls. It has to be passed explicitly as a custom parameter. VI's streaming object accepts flow variables as values, for example key `cli`, value `$cli` (manual, page 4).

None of these calls ran the Ganesh script. Every call that got through on the Ganesh link ran as UCB, with UCB's agent `59e44c8b-…` and a UCB campaign. Calls on the Ganesh link whose number matched no pending campaign number were refused: 31 such calls on 6–7 Nov, 20 of them between 15:00 and 16:00 on 7 Nov. Those callers got no bot.

## Questions for VI support

Example call IDs:

- UCB link: `48724128`, `48724127`, `48724123` (14:01)
- Ganesh link: `48733153` (14:03), `48747176` (14:05), `48750066` (14:06)

1. Campaign ref 772576 was created on our Flow at 14:01. Why do some of its calls stream to `…/voicebot/97752ef1-…` (the old Ganeshotsav URL, no custom parameters) and the rest to `…/voicebot/4c9a8c38-…` (with custom parameters)? Is an older version of the Flow, or a Streaming Object attached at DNI 9112002517 level, still active for part of the calls?
2. Please remove `…/voicebot/97752ef1-…` from every Flow, version and DNI-level Streaming configuration of DNI 9112002517.
3. In the Streaming Object that points at `…/voicebot/4c9a8c38-…`:
   - add the custom parameter `msisdn` = the base variable `$msisdn`, i.e. the dialled customer number;
   - remove the fixed `campaign_id`.
   VI allows at most 3 custom parameters, so keep `msisdn`, and optionally `call_type`, and drop the rest.
