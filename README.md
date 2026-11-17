# websub-server

A minimal [WebSub](https://www.w3.org/TR/websub/) hub for a fixed set of feeds. The feeds are configured in a
static JSON5 file. There is no database: state lives in memory and in one JSON file per feed.

* Up to 100 feeds with up to 1000 subscriptions each (configurable).
* Publishers report updates at a secret notification URL. The hub then fetches the feed and delivers it to the
  subscribers when its content has changed.
* Leases of up to 28 days.

## Running

```sh
npm install
cp websub.example.json5 websub.json5   # edit feeds, tokens and baseUrl
cp .env.example .env
npm start
npm test
```

Environment variables (see `.env.example`):

| Variable | Description |
|---|---|
| `WEBSUB_CONFIG` | Path of the config file. Default `./websub.json5`. |
| `WEBSUB_VAR` | Data directory. Overrides `varDir`. |
| `WEBSUB_PORT`, `WEBSUB_BASE_URL` | Override `port` and `baseUrl`. |
| `WEBSUB_ALLOW_PRIVATE_TARGETS` | `true` allows callbacks and feeds on private addresses and IP literals. Development only. |
| `LIMITS_*` | Global and per-IP request limits, see `lib/limits.middleware.ts`. |
| `HAPPY_SECRET` | Secret of the `/happy` health endpoint. |

## Configuration

See `websub.example.json5`. Each entry in `feeds` has:

* an id (`[a-z0-9-]`, at most 64 characters), which is part of the hub URL;
* `topic` (one URL) or `topics` (up to 10 URLs, e.g. the RSS and JSON versions of a feed). Each topic is a
  separate WebSub topic, but one notification checks all of them;
* `token`: the secret path segment of the notification URL. 8 to 256 characters of `A-Z a-z 0-9 . _ ~ -`, unique
  per feed. It only protects against needless fetches, so it doesn't need to be long.

`limits` is optional. The example file lists all limits with their defaults.

## Announcing the hub

The feed must link to the hub and to itself, so subscribers can discover both (WebSub §4).

RSS / Atom:

```xml
<atom:link rel="hub" href="https://hub.example.net/websub/subscribe/tim"/>
<atom:link rel="self" href="https://tim.example.com/feed.xml"/>
```

JSON Feed:

```json
"feed_url": "https://tim.example.com/feed.json",
"hubs": [{ "type": "WebSub", "url": "https://hub.example.net/websub/subscribe/tim" }]
```

The self URL must be exactly one of the configured topics.

## Endpoints

### `POST /websub/subscribe/:feed`

Subscribers use the standard WebSub subscription request (§5.1), form-encoded:

| Parameter | |
|---|---|
| `hub.mode` | `subscribe` or `unsubscribe` |
| `hub.topic` | One of the feed's topics. |
| `hub.callback` | A public http(s) URL with a host name (no IP literal, no credentials). The fragment is removed. |
| `hub.lease_seconds` | Optional. Clamped to `minLeaseSeconds`…`maxLeaseSeconds`. Default `defaultLeaseSeconds`. |
| `hub.secret` | Optional. Printable ASCII, less than 200 bytes. Only accepted if `baseUrl` is https. |

Responses:

| Status | Meaning |
|---|---|
| `202` | Accepted. The hub then verifies the intent with a GET to the callback (§5.3), carrying `hub.mode`, `hub.topic`, `hub.challenge` and `hub.lease_seconds`. The callback must answer with a 2xx and the challenge as body; redirects are not followed. Only then is the subscription stored, renewed or removed. |
| `400` | Invalid parameters, unsubscribing from an unknown subscription, or a request for this subscription that is still being verified. |
| `404` | Unknown feed. |
| `409` | The feed has reached `maxSubscriptionsPerFeed`, or `maxSubscriptionsPerCallbackHost` for this callback host. Pending verifications count toward both limits. Renewals never hit them. |
| `503` | Too many verifications are pending (`maxPendingVerifications`). |

Subscribing again with the same topic and callback renews the subscription, replacing its lease and secret. If a
limit is reached between the request and its verification, the hub sends a `hub.mode=denied` GET (§5.2).

### `POST /websub/notification/:token`

The publisher reports that its feed was updated. No body is needed.

* `202 {"status": "scheduled"}`: the hub waits `notifyDelaySeconds` (2 minutes) and then fetches all topics of the
  feed. A topic counts as changed if it is fetched for the first time or the SHA-256 of its body has changed.
  Changed topics are distributed. If none has changed, the hub fetches again every `recheckIntervalSeconds`
  (1 minute), at most `maxRechecks` (100) times, until one has changed. Failed fetches count as unchanged.
* `202 {"status": "pending"}`: a check for this feed is already running. Another check starts after it, so an
  update that arrives while the hub is still waiting is not missed.
* `404`: unknown token.
* `429`: more than `maxNotificationsPerHour` notifications for this feed in the last hour. `Retry-After` gives the
  wait time.

## Distribution

The changed topic is POSTed to every subscriber with a lease that hasn't expired (§7), with:

* the body as fetched and its `Content-Type`;
* `Link: <hub URL>; rel="hub", <topic>; rel="self"`;
* `X-Hub-Signature: sha256=<HMAC-SHA256 of the body, hex>` if the subscriber gave a secret.

At most `maxParallelRequests` verifications and deliveries run at a time. Redirects are not followed.

What happens when a delivery fails:

* **4xx, 3xx or any other non-2xx except 5xx:** the subscription ends immediately. This includes 410 Gone.
* **5xx, timeout or network error:** the delivery is retried up to `deliveryRetries` (2) times,
  `deliveryRetryDelaySeconds` (5 minutes) apart. If it still fails, the subscription ends. A retry is dropped if
  newer content has been distributed in the meantime. With `deliveryRetries: 0`, every failure ends the
  subscription.

Expired subscriptions are removed every hour.

## Security

* **Input checks:** every parameter is type-checked and length-limited. Strings with control characters or
  invisible formatting characters (bidi overrides, zero-width characters, …) are rejected. Repeated form fields
  are rejected. URLs are normalized to their ASCII href.
* **Request size and rate:** request bodies are limited to 8 kB. Requests are rate-limited globally and per IP,
  and notifications additionally per feed.
* **SSRF:** outgoing requests (feed fetches, verifications, deliveries) only go to http(s) URLs with a host name
  that resolves to a public address. The address is checked inside the DNS lookup, so DNS rebinding doesn't get
  around it. Every request has a timeout, and response bodies are size-limited.
* **Tokens:** notification tokens are compared in constant time and never logged.
* **Behind a proxy:** the hub is meant to run behind Cloudflare or another TLS proxy. For the per-IP limits, the
  origin must only be reachable through the proxy (see `lib/limits.middleware.ts`).

## Storage

`$VAR/feeds/<feed id>.json`, mode 0600 because it contains subscriber secrets. Each file holds:

* `topics`: the checksum and time of the last change of each topic;
* `subscriptions`: topic, callback, host, secret, lease, expiry and creation time.

The files are written atomically after every change and read at startup. Subscriptions for topics that are no
longer configured are dropped on load. Pending verifications, running checks and retries are lost on restart.
Because checksums persist, a restart doesn't cause a redistribution of unchanged feeds.
