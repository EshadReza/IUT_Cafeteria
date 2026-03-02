# 🍛 IUT Cafeteria — Iftar Rush Distributed System

> A production-grade microservices architecture built to survive the most chaotic moment in student life: 500 hungry engineers hitting "Order Now" at exactly 5:30 PM during Ramadan.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Architecture Overview](#architecture-overview)
3. [Quick Start](#quick-start)
4. [Services Deep Dive](#services-deep-dive)
5. [Data Flow — A Full Order Lifecycle](#data-flow--a-full-order-lifecycle)
6. [Security Model](#security-model)
7. [Resilience & Fault Tolerance](#resilience--fault-tolerance)
8. [Performance & Caching](#performance--caching)
9. [Observability](#observability)
10. [Frontend](#frontend)
11. [CI/CD Pipeline](#cicd-pipeline)
12. [API Reference](#api-reference)
13. [Infrastructure](#infrastructure)
14. [Testing](#testing)
15. [Chaos Engineering](#chaos-engineering)
16. [Bonus Features](#bonus-features)
17. [Configuration Reference](#configuration-reference)
18. [Development Guide](#development-guide)

---

## The Problem

The old IUT Cafeteria ran on a single monolithic Node.js server backed by a single database. Every Ramadan, the same failure pattern repeated:

- 5:30 PM: Ordering opens
- 5:30:03 PM: Database connection pool exhausted
- 5:30:07 PM: Thread deadlocks begin
- 5:30:15 PM: Server freezes entirely
- 5:30:16 PM: Students stare at a loading spinner wondering if their Iftar was ordered or not
- 5:31:00 PM: Physical queue forms. Chaos ensues.

The root cause was coupling: every concern — authentication, stock management, order processing, and notifications — lived in one process. One bottleneck brought everything down.

This system replaces it with a **distributed, fault-tolerant microservice architecture** where each concern is isolated, independently scalable, and designed to degrade gracefully rather than fail completely.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Student Browser                         │
│                    http://localhost (port 80)                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                        Frontend (Nginx)                          │
│              Single-page app served as static HTML               │
└───────────┬───────────────────────────┬──────────────────────────┘
            │ REST                       │ SSE (EventSource)
            ▼                           ▼
┌───────────────────────┐   ┌───────────────────────────────────┐
│   Identity Provider   │   │         Notification Hub          │
│       :3001           │   │              :3005                │
│                       │   │  Real-time push via SSE streams   │
│  • JWT issuance       │   │  No polling required              │
│  • Rate limiting      │   └───────────────┬───────────────────┘
│    (3/min per user)   │                   │ POST /notify
└───────────────────────┘                   │
                                            │
┌───────────────────────────────────────────┼───────────────────┐
│              Order Gateway :3002          │                   │
│                                           ▼                   │
│  1. Verify JWT token (401 if missing)                         │
│  2. Cache-first stock check (Redis)    ◄──────┐               │
│  3. POST notify → PENDING              Redis   │               │
│  4. Decrement stock (Stock Service) ───────────┘               │
│  5. POST notify → STOCK_VERIFIED                               │
│  6. Enqueue to Kitchen (async, <2s)                            │
│  7. Return 200 immediately                                     │
└────────────┬────────────────────────────────────────────────┬──┘
             │ HTTP                                            │ HTTP
             ▼                                                 ▼
┌────────────────────────┐               ┌────────────────────────────┐
│    Stock Service       │               │      Kitchen Queue         │
│        :3003           │               │          :3004             │
│                        │               │                            │
│  • Redis WATCH/MULTI   │               │  • Publishes to RabbitMQ   │
│    optimistic locking  │               │  • Immediately ACKs        │
│  • Idempotency keys    │               │  • Worker consumes queue   │
│  • 5-retry loop on     │               │  • Simulates 3-7s cook     │
│    write conflicts     │               │  • POSTs IN_KITCHEN/READY  │
└────────────────────────┘               │    to Notification Hub     │
                                         └────────────────────────────┘
                                                      │
                                                      ▼
                                              ┌──────────────┐
                                              │   RabbitMQ   │
                                              │    :5672     │
                                              │  (durable    │
                                              │   queue)     │
                                              └──────────────┘

Infrastructure (shared):
  ┌───────────┐   ┌─────────────────────────┐
  │   Redis   │   │   Chaos Controller      │
  │   :6379   │   │        :3006            │
  │           │   │  (Docker socket access) │
  └───────────┘   └─────────────────────────┘
```

### Why This Architecture?

| Concern | Solution | Why |
|---|---|---|
| Peak load on order entry | Redis cache gate in Gateway | Blocks zero-stock requests before they hit any service |
| Concurrent stock updates | Optimistic locking (WATCH/MULTI) | No database locks; retries resolve conflicts |
| Slow kitchen processing | RabbitMQ async queue | User gets confirmation instantly; cooking happens in background |
| Real-time order status | Server-Sent Events | No polling; no WebSocket complexity; works through proxies |
| Auth coupling | Dedicated Identity Provider | Token issued once; verified locally in gateway via shared secret |
| Partial failure cascades | Health checks + graceful degradation | Each service knows its own health; gateway surfaces dependencies |

---

## Quick Start

**Prerequisites:** Docker and Docker Compose installed. Nothing else needed.

```bash
# Clone the repository
git clone <your-repo-url>
cd iut-cafeteria

# Build and start everything
docker compose up --build

# Or start in the background
docker compose up --build -d
```

Wait roughly **30–40 seconds** for RabbitMQ to fully initialize. You'll see `kitchen-queue` log `Connected to RabbitMQ` when it's ready.

Then open **http://localhost** in your browser.

**To stop:**
```bash
docker compose down

# To also remove volumes (wipes Redis stock data):
docker compose down -v
```

**To rebuild a single service after a code change:**
```bash
docker compose up --build order-gateway
```

---

## Services Deep Dive

### Identity Provider — Port 3001

The single source of truth for authentication. No other service issues tokens — they only verify them.

**Responsibilities:**
- Accepts a `studentId` + `password` and returns a signed JWT
- Enforces rate limiting: **3 login attempts per minute per student ID** — prevents brute-force attacks and script-based order botting during the rush
- Provides a `/auth/verify` endpoint for internal token introspection (used during development/debugging; the Gateway verifies tokens locally in production for speed)

**Token contents:**
```json
{
  "studentId": "STU001",
  "name": "Ahmed Hassan",
  "role": "student",
  "iat": 1710000000,
  "exp": 1710007200
}
```

Tokens expire after **2 hours**. The JWT secret is shared with the Order Gateway via environment variable so the Gateway can verify tokens without making a network call on every request.

**Key implementation detail — Rate limiting:**

Rate limiting is keyed on `IP + studentId` combined, not just IP. This means a student can't bypass the limit by rotating IPs (or, more realistically, hitting the endpoint from different browser tabs), and it doesn't unfairly block an entire IP that might be shared (e.g., university WiFi NAT).

```
POST /auth/login  →  Rate: 3 req/min per (IP + studentId)
                      429 Too Many Requests after limit
```

---

### Order Gateway — Port 3002

The only public-facing API endpoint. All order operations funnel through here. It performs several critical functions before a request ever reaches a database:

**Request pipeline (in order):**

1. **JWT Verification** — Checks `Authorization: Bearer <token>`. Returns `401` immediately if missing or invalid. No downstream service is called.

2. **Order Structure Validation** — Validates item IDs against the known menu and checks quantities are positive integers not exceeding the per-order limit of 10. Returns `400` with detailed errors before touching any infrastructure.

3. **Cache-First Stock Check** — Reads stock levels from Redis. If the cache shows zero stock for any requested item, the request is rejected with `409` immediately. This is the key performance guard: during peak rush, the vast majority of "out of stock" rejections never reach the Stock Service or its database at all.

4. **Notify PENDING** — Fires an async notification to the Notification Hub so the student's UI transitions immediately to "Pending" state.

5. **Stock Decrement** — Calls the Stock Service to perform the actual atomic stock deduction with optimistic locking. If this fails (stock just ran out, concurrent conflict), the order is rejected and the student is notified.

6. **Update Cache** — On successful decrement, writes the new stock level back to Redis with a 60-second TTL.

7. **Notify STOCK_VERIFIED** — Updates the student's UI.

8. **Kitchen Queue** — POSTs the order to the Kitchen Queue service, which acknowledges within 2 seconds. The actual cooking happens asynchronously.

9. **Return 200** — Student's order is confirmed.

**Why cache-first matters under load:**

Without the cache gate, every "order now" button press during the rush would hit the Stock Service's Redis with a WATCH/MULTI transaction. With 500 concurrent students, that's 500 competing transactions all fighting for the same stock keys. The cache gate means only requests that *could* succeed based on last-known state reach the locking layer. Failed requests (zero stock) are turned away in microseconds.

---

### Stock Service — Port 3003

The authoritative source for inventory. This service owns the stock data — Redis is its storage layer, not just a cache.

**Concurrency control via Optimistic Locking:**

The stock decrement uses Redis `WATCH`/`MULTI`/`EXEC` — Redis's built-in optimistic locking primitive:

```
1. WATCH stock:biryani          ← "tell me if this key changes"
2. GET stock:biryani            ← read current value (e.g., 47)
3. Check: 47 >= requested qty?
4. MULTI                        ← begin transaction
5. DECRBY stock:biryani 1
6. SET idempotent:<orderId> 1   ← record this order was processed
7. EXEC                         ← commit atomically
```

If another request modified `stock:biryani` between step 1 and step 7, `EXEC` returns `null` (the watch was tripped). The service retries the entire sequence up to **5 times**. This means:

- **No locks are held** between read and write — no deadlocks possible
- **Concurrent requests resolve themselves** through retry rather than queuing
- **Overselling is impossible** — the final decrement only happens if the value at commit time is still valid

**Idempotency:**

Every decrement call includes the `orderId`. Before processing, the service checks `idempotent:decrement:<orderId>` in Redis. If it exists, the request is a duplicate (e.g., a retry after a network timeout) and the service returns success without decrementing again. The idempotency key expires after 1 hour.

This solves the classic partial failure scenario: the Gateway decrements stock, the network drops before the response arrives, the Gateway retries — and the student doesn't end up paying for two portions.

**Menu items (seeded on startup):**

| ID | Name | Default Stock | Price |
|---|---|---|---|
| biryani | Chicken Biryani | 100 | ৳120 |
| khichuri | Special Khichuri | 100 | ৳80 |
| haleem | Beef Haleem | 100 | ৳150 |
| dates | Dates Pack | 100 | ৳50 |
| juice | Mixed Fruit Juice | 100 | ৳60 |

Stock is only seeded if the key doesn't already exist in Redis, so restarts don't reset stock mid-service.

---

### Kitchen Queue — Port 3004

Decouples the "acknowledgment" of an order from the "execution" of cooking it.

**Why a message queue here?**

Without a queue, the Gateway would have to wait for the kitchen to finish cooking (3–7 seconds) before responding to the student. That means every order request ties up a connection for up to 7 seconds — catastrophic at scale.

With RabbitMQ:
1. Gateway POSTs to Kitchen Queue → Kitchen Queue publishes message → returns `200` in **<100ms**
2. A background consumer picks up the message and starts processing
3. When cooking finishes (3–7s later), it notifies the Notification Hub

**RabbitMQ configuration:**
- Queue name: `kitchen_orders`
- Queue is `durable: true` — survives a RabbitMQ restart
- Messages are `persistent: true` — survive a broker crash
- Consumer uses **explicit ACK** — messages are only removed from the queue after successful processing. If the consumer crashes mid-cook, the message is requeued.

**Startup retry logic:**

RabbitMQ takes longer to start than the Kitchen Queue container. The service retries connection every 3 seconds for up to 10 attempts (30 seconds total) before giving up. Docker Compose's `depends_on: condition: service_healthy` provides an additional gate.

**Consumer flow:**
```
1. Receive message from queue
2. POST /notify → IN_KITCHEN  (student sees "Being prepared 👨‍🍳")
3. Sleep 3–7 seconds (simulates cooking)
4. POST /notify → READY       (student sees "Come pick it up 🎉")
5. ACK message                (removed from queue)
```

---

### Notification Hub — Port 3005

Pushes real-time order status updates directly to the student's browser using **Server-Sent Events (SSE)**.

**Why SSE over WebSockets?**

SSE is unidirectional (server → client) which is exactly what's needed here — the browser never needs to send data after subscribing. SSE works through HTTP/1.1 without any protocol upgrade, passes through standard reverse proxies, and is natively supported in all modern browsers with no library needed (`EventSource` API).

**How it works:**

```
Browser: GET /events/<orderId>     ← opens long-lived HTTP connection
Server:  Content-Type: text/event-stream
         Connection: keep-alive

         data: {"status":"PENDING","message":"..."}

         data: {"status":"STOCK_VERIFIED","message":"..."}

         data: {"status":"IN_KITCHEN","message":"..."}

         data: {"status":"READY","message":"..."}
```

Each status update from any other service reaches the Notification Hub via `POST /notify`. The Hub stores the latest status in memory and fans it out to all active SSE connections for that `orderId`.

**Late-joining clients:** If a student refreshes the page after an order is placed, the Hub sends the current status immediately on connection so the tracker jumps to the right state.

**Memory management:** Client connections are tracked per `orderId` in a `Map<orderId, Set<Response>>`. Connections are cleaned up on the `close` event.

---

### Chaos Controller — Port 3006

A lightweight service that exposes the Docker API to the frontend, enabling real service kill/revive operations for the chaos engineering demo.

It mounts the Docker socket (`/var/run/docker.sock`) and uses the `dockerode` library to stop and start containers by name.

```
POST /chaos/kill/:service    → docker stop <container>
POST /chaos/revive/:service  → docker start <container>
GET  /chaos/status           → current state of all service containers
```

When a service is killed via the Admin UI, the health grid immediately turns red, dependent service health checks begin returning 503, and you can observe exactly how the system degrades. Reviving restores the container and health checks recover within one polling cycle.

---

## Data Flow — A Full Order Lifecycle

Here is the exact sequence of events when a student successfully orders Biryani:

```
t=0ms    Student clicks "Place Iftar Order"
         Browser → POST /orders (Gateway) with Bearer token

t=1ms    Gateway: JWT verified ✓
t=2ms    Gateway: Order validated (biryani, qty=1) ✓
t=3ms    Gateway: Redis GET stock:biryani → "47" ✓ (>=1)

t=5ms    Gateway → POST /notify (NotifHub)
         NotifHub stores {orderId, status: "PENDING"}
         NotifHub → SSE push to browser
t=6ms    Browser: tracker moves to PENDING ⏳

t=8ms    Gateway → POST /stock/biryani/decrement (StockSvc)
         StockSvc: WATCH stock:biryani
         StockSvc: GET → 47
         StockSvc: MULTI → DECRBY 1, SET idempotent:orderId
         StockSvc: EXEC → success, newQty=46
t=12ms   Gateway: Redis SET stock:biryani 46 (EX 60)

t=14ms   Gateway → POST /notify
         NotifHub → SSE push
t=15ms   Browser: tracker moves to STOCK_VERIFIED ✅

t=17ms   Gateway → POST /orders (KitchenQueue)
         KitchenQueue: channel.sendToQueue("kitchen_orders", ...)
         KitchenQueue: returns 200 immediately
t=20ms   Gateway → 200 OK to browser {orderId, status: "QUEUED"}

t=21ms   Browser: shows "Order accepted!"

--- (async from here) ---

t=22ms   RabbitMQ delivers message to KitchenQueue consumer
t=23ms   KitchenQueue → POST /notify
         NotifHub → SSE push
t=24ms   Browser: tracker moves to IN_KITCHEN 👨‍🍳

t=5500ms (3-7s later) KitchenQueue finishes "cooking"
         KitchenQueue → POST /notify
         NotifHub → SSE push
t=5501ms Browser: tracker moves to READY 🎉
         Progress bar turns green
         SSE connection closed
```

Total time from button click to confirmed response: **~20ms**.  
Time until food is ready notification: **~5.5 seconds**.

---

## Security Model

### JWT Authentication

All Order Gateway routes require a valid Bearer token. The token is verified locally using the shared `JWT_SECRET` — no network call to the Identity Provider on each request. This is intentional: adding a network hop to every authenticated request would add latency and create a dependency that, if it went down, would take the entire ordering system with it.

```
Client                  Gateway                Identity Provider
  │                        │                          │
  │── POST /auth/login ────────────────────────────►  │
  │◄─ { token } ──────────────────────────────────────│
  │                        │                          │
  │── POST /orders ──────► │                          │
  │   Authorization:        │ jwt.verify(token,        │
  │   Bearer <token>        │   JWT_SECRET) ← local   │
  │                        │ No network call needed   │
  │◄─ 200 OK ─────────────│                          │
```

### Protected Routes

Any request to `POST /orders` or `GET /stock` without a valid token receives:

```json
HTTP 401 Unauthorized
{ "error": "Missing bearer token" }
```

or if the token is present but expired/tampered:

```json
HTTP 401 Unauthorized
{ "error": "Invalid or expired token" }
```

### Rate Limiting

The Identity Provider enforces **3 login attempts per minute** keyed on `IP + studentId`. After the third attempt:

```json
HTTP 429 Too Many Requests
{ "error": "Too many login attempts. Try again in 1 minute." }
```

Standard rate-limit headers (`RateLimit-*`) are included in the response so clients can implement backoff.

---

## Resilience & Fault Tolerance

### Idempotency

The stock decrement endpoint accepts an optional `orderId` field. When present, it writes an idempotency key (`idempotent:decrement:<orderId>`) to Redis atomically with the decrement. If the same `orderId` arrives again (network retry), the endpoint detects the key and returns success without touching stock:

```json
{ "success": true, "idempotent": true, "message": "Already processed" }
```

This makes the decrement operation **safe to retry** — critical in a distributed system where the Gateway might retry after a timeout.

### Optimistic Locking with Retry

The Stock Service uses Redis `WATCH`/`MULTI`/`EXEC` with up to 5 retries. Under normal load this resolves in 1–2 attempts. Under extreme concurrency (hundreds of simultaneous decrements on the same item), the retry loop prevents overselling while avoiding lock contention.

If all 5 retries fail (extremely unusual), the service returns `500` with `"Too many concurrent modifications, try again"` — the frontend can display this and let the user retry.

### Async Decoupling

The Kitchen Queue immediately returns `200 QUEUED` after publishing to RabbitMQ. The cooking process runs entirely in background. This means:

- A slow kitchen (or a kitchen service restart) does not affect order acknowledgment time
- RabbitMQ's durable queue persists orders across service restarts — no orders are lost if the Kitchen container crashes mid-rush
- The explicit ACK pattern means a crash during cooking causes the message to be redelivered on restart

### Graceful Degradation

If the Notification Hub goes down, the rest of the order flow continues — the order is placed, stock is decremented, and the kitchen receives the job. The student just won't see real-time updates. This is a degraded but functional state.

If the Stock Service goes down, the Order Gateway returns `502 Stock service unavailable` with the `orderId` that was generated — so if the student retries after the service recovers, the idempotency key prevents double-decrement.

---

## Performance & Caching

### Cache-First Stock Check

Redis serves as a high-speed gate in front of the Stock Service. The Gateway checks Redis *before* contacting the Stock Service:

```
Request arrives
      │
      ▼
Redis GET stock:<itemId>
      │
      ├─ Key exists AND value < requested qty?
      │         └── Return 409 instantly (no downstream calls)
      │
      └─ Key missing OR value sufficient?
                └── Proceed to Stock Service
```

Cache entries are written with a **60-second TTL** and updated on every successful decrement. During the Ramadan rush, this means the first request for each item after a decrement reads from Redis, and subsequent requests within 60 seconds are served from cache — the Stock Service is only hit when stock actually changes.

### What the Cache Protects Against

During a rush with 500 concurrent users, the naive approach (no cache) results in:
- 500 requests hitting the Stock Service
- 500 Redis WATCH transactions competing
- Many retries, high latency

With the cache gate, after the first few decrements drop stock to zero:
- All remaining requests hit Redis, see zero, and return `409` in ~2ms
- The Stock Service receives zero load for those items
- RabbitMQ and the Kitchen stay completely unaffected

---

## Observability

Every service exposes two standard endpoints:

### `GET /health`

Returns `200 OK` if the service and all its dependencies are reachable, or `503 Service Unavailable` if any dependency is down.

**Order Gateway `/health` example (all ok):**
```json
{
  "status": "ok",
  "service": "order-gateway",
  "dependencies": {
    "stock-service": "ok",
    "kitchen-queue": "ok",
    "notification-hub": "ok",
    "redis": "ok"
  }
}
```

**Stock Service `/health` example (Redis down):**
```json
HTTP 503
{
  "status": "degraded",
  "service": "stock-service",
  "dependencies": {
    "redis": "down"
  }
}
```

### `GET /metrics`

Machine-readable operational data. Each service exposes what it knows about:

**Order Gateway `/metrics`:**
```json
{
  "totalOrders": 142,
  "failedOrders": 8,
  "errors": 2,
  "avgLatencyMs": 23,
  "avgLatency30sMs": 18,
  "alertHighLatency": false,
  "requestCount": 389
}
```

**Stock Service `/metrics`:**
```json
{
  "totalDecrements": 134,
  "failedDecrements": 8,
  "avgLatencyMs": 6,
  "requestCount": 201
}
```

**Notification Hub `/metrics`:**
```json
{
  "totalNotifications": 412,
  "errors": 0,
  "avgLatencyMs": 3,
  "activeConnections": 7,
  "requestCount": 450
}
```

The Admin Dashboard polls all of these every 5 seconds and visualizes them in real time.

---

## Frontend

A single HTML file served by Nginx with no build step required. Deliberately zero-dependency — no React, no bundler, no node_modules on the frontend.

### Student View

**Login screen** — authenticates against the Identity Provider, stores the JWT in `sessionStorage` (cleared on tab close).

**Menu** — fetches stock via the authenticated Gateway `/stock` endpoint. Items show live quantity counts and are marked as out-of-stock when depleted. Clicking an item cycles through quantities 1–5; clicking again at 5 resets to 0.

**Order basket** — dynamically calculates total price and enables the "Place Iftar Order" button when at least one item is selected.

**Live order tracker** — after placing an order, subscribes to `GET /events/<orderId>` on the Notification Hub. The four-step progress bar (Pending → Stock Verified → In Kitchen → Ready) updates in real time as SSE events arrive. No polling.

**Event log** — timestamped log of every SSE event received in the current session, useful for demonstrating the real-time pipeline to judges.

### Admin Dashboard

**Health Grid** — polls `GET /health` on all 5 services every 5 seconds. Cards turn green/red with animated indicators. The nav bar system status indicator reflects overall health.

**Live Metrics** — pulls `GET /metrics` from the Gateway and Notification Hub. Displays total orders, failed orders, average latency (all-time and 30-second window), active SSE connections, and total notifications sent.

**High Latency Alert** — a red flashing banner appears if the Gateway's 30-second average latency exceeds 1000ms. This is surfaced directly from the `alertHighLatency` field in the metrics response.

**Chaos Controls** — kill/revive buttons for each service. These call the Chaos Controller's `POST /chaos/kill/:service` and `POST /chaos/revive/:service` endpoints, which stop and start the actual Docker containers. Observe the health grid turn red and watch dependent services begin returning degraded status in their own health checks.

**Stock Reset** — resets all item stock to 100 units via `POST /stock/reset-all`.

---

## CI/CD Pipeline

Located at `.github/workflows/ci.yml`. Triggers on every push to `main` and on all pull requests targeting `main`.

### Pipeline Stages

```
Push to main
     │
     ├─── test-identity-provider (parallel)
     │       npm install → npm test (Jest)
     │
     ├─── test-order-gateway (parallel)
     │       npm install → npm test (Jest)
     │       Tests: 7 cases covering order validation logic
     │
     └─── test-stock-service (parallel)
             npm install → npm test (Jest)
             Tests: 5 cases covering stock deduction logic
                    │
                    │ (all three must pass)
                    ▼
             build-images
               docker compose build --parallel
               docker compose up -d
               sleep 30 (wait for RabbitMQ)
               curl health checks on :3001, :3003, :3005
               docker compose down -v
```

**Key property:** The build job only runs after all three test jobs succeed. A single failing test blocks the Docker build entirely — broken code cannot reach the production compose stack.

Tests are unit tests against pure logic functions (no mocking of external services required), so they run fast and don't need Redis or RabbitMQ to be present in CI.

---

## API Reference

### Identity Provider `:3001`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/auth/login` | None | `{studentId, password}` | `{token, student}` |
| POST | `/auth/verify` | None | `{token}` | `{valid, payload}` |
| GET | `/health` | None | — | `{status}` |
| GET | `/metrics` | None | — | `{totalLogins, failedLogins, avgLatencyMs}` |

**Rate limited:** `POST /auth/login` → 3 requests/minute per `IP+studentId`.

---

### Order Gateway `:3002`

All routes except `/health` and `/metrics` require `Authorization: Bearer <token>`.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/orders` | ✓ | `{items: [{itemId, quantity}], total}` | `{success, orderId, status, latencyMs}` |
| GET | `/stock` | ✓ | — | `{biryani: {name, price, quantity, emoji}, ...}` |
| GET | `/health` | None | — | `{status, dependencies}` |
| GET | `/metrics` | None | — | `{totalOrders, failedOrders, avgLatencyMs, avgLatency30sMs, alertHighLatency}` |

**Order errors:**
- `400` — validation failure (invalid itemId, zero quantity, exceeds 10 items)
- `401` — missing or invalid JWT
- `409` — out of stock
- `502` — downstream service unreachable

---

### Stock Service `:3003`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/stock` | — | Full inventory map |
| GET | `/stock/:itemId` | — | `{itemId, name, price, quantity, emoji}` |
| POST | `/stock/:itemId/decrement` | `{quantity, orderId}` | `{success, newQuantity}` |
| POST | `/stock/:itemId/reset` | `{quantity}` | `{success, itemId, quantity}` |
| POST | `/stock/reset-all` | — | `{success, message}` |
| GET | `/health` | — | `{status, dependencies: {redis}}` |
| GET | `/metrics` | — | `{totalDecrements, failedDecrements, avgLatencyMs}` |

---

### Kitchen Queue `:3004`

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/orders` | `{orderId, studentId, items, total}` | `{success, orderId, status: "QUEUED"}` |
| GET | `/health` | — | `{status, dependencies: {rabbitmq}}` |
| GET | `/metrics` | — | `{totalOrders, failedOrders, avgLatencyMs}` |

---

### Notification Hub `:3005`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/events/:orderId` | — | SSE stream (`text/event-stream`) |
| POST | `/notify` | `{orderId, status, message, data}` | `{success, subscriberCount}` |
| GET | `/statuses` | — | Map of all current order statuses |
| GET | `/health` | — | `{status, connectedClients}` |
| GET | `/metrics` | — | `{totalNotifications, activeConnections, avgLatencyMs}` |

**SSE event format:**
```
data: {"orderId":"uuid","status":"IN_KITCHEN","message":"Your order is being prepared 👨‍🍳","timestamp":"2024-03-15T17:32:01.000Z"}
```

**Valid statuses:** `PENDING` → `STOCK_VERIFIED` → `IN_KITCHEN` → `READY` → `FAILED`

---

### Chaos Controller `:3006`

| Method | Path | Response |
|---|---|---|
| POST | `/chaos/kill/:service` | `{success, action: "killed", containerId}` |
| POST | `/chaos/revive/:service` | `{success, action: "revived", containerId}` |
| GET | `/chaos/status` | `{service: "running"|"exited"|"not found"}` |
| GET | `/health` | `{status: "ok"}` |

**Valid service names:** `identity-provider`, `order-gateway`, `stock-service`, `kitchen-queue`, `notification-hub`

---

## Infrastructure

### Redis

Used in two distinct roles:

1. **Stock storage (Stock Service)** — the authoritative store for inventory levels. Keys: `stock:<itemId>`.
2. **Order cache (Order Gateway)** — a fast read-ahead cache. Same key namespace, 60s TTL.
3. **Idempotency store (Stock Service)** — `idempotent:decrement:<orderId>`, 1h TTL.

Runs as `redis:7-alpine`. Data is persisted to a named Docker volume (`redis-data`) so stock survives container restarts.

### RabbitMQ

Single durable queue: `kitchen_orders`. Management UI available at `http://localhost:15672` (credentials: `cafeteria` / `iftar2024`).

Queue durability settings ensure no orders are lost on broker restart. The Kitchen Queue consumer uses explicit ACK so messages are only removed after successful processing.

---

## Testing

### Unit Tests

Tests cover the pure business logic functions that don't require live services:

**Order Validation (`order-gateway/src/orderValidation.test.js`)** — 7 test cases:
- Valid order passes
- Empty items array rejected
- Unknown `itemId` rejected with descriptive error
- Zero quantity rejected
- Negative quantity rejected
- Exceeding 10-item maximum rejected
- Null order fails gracefully

**Stock Logic (`stock-service/src/stock.test.js`)** — 5 test cases:
- Correct decrement calculation
- Insufficient stock throws
- Zero quantity throws
- Negative quantity throws
- Exact stock match succeeds

**Identity Provider (`identity-provider/src/index.test.js`)** — 5 test cases:
- Valid credentials return token
- Invalid password returns 401
- Missing fields return 400
- Valid token passes verification
- Health endpoint returns 200

### Running Tests Locally

```bash
# Identity Provider
cd identity-provider && npm install && npm test

# Order Gateway
cd order-gateway && npm install && npm test

# Stock Service
cd stock-service && npm install && npm test
```

---

## Chaos Engineering

The Admin Dashboard's chaos controls are backed by real Docker API calls:

```
Admin UI → POST /chaos/kill/stock-service
        → Chaos Controller → docker stop iut-cafeteria-stock-service-1
        → Container exits
        → Health grid: stock-service turns RED
        → Order Gateway /health: stock-service: "down"
        → Orders attempted: 502 "Stock service unavailable"
```

**Interesting scenarios to try during the demo:**

1. **Kill Notification Hub** — orders still complete (Gateway continues), but the order tracker freezes. The order is placed and stock is decremented; students just don't see real-time updates. Demonstrates notification as a non-critical path.

2. **Kill Stock Service** — orders fail at step 4 with 502. Idempotency ensures that if you revive the service and retry the same `orderId`, stock is only decremented once.

3. **Kill Kitchen Queue** — stock is decremented but orders fail at step 6. Students are left in `STOCK_VERIFIED` state. Reviving the kitchen doesn't automatically re-process these orders (they'd need to be retried), which is a realistic eventual-consistency scenario.

4. **Kill Identity Provider** — existing tokens continue working (verified locally). Only new logins fail. Demonstrates why local token verification matters.

---

## Bonus Features

### ✅ Rate Limiting
Identity Provider enforces 3 login attempts per minute per `IP + studentId`. Implemented with `express-rate-limit`, returns `429` with standard headers.

### ✅ Visual Latency Alert
The Order Gateway's `/metrics` endpoint computes a rolling 30-second average latency alongside the all-time average. If `avgLatency30sMs > 1000`, it sets `alertHighLatency: true`. The Admin Dashboard reads this field and shows a flashing red alert banner. No separate monitoring service needed — the signal originates from the gateway itself.

### ✅ Chaos Toggle
Real container stop/start via Docker socket. Not simulated — actual service failures observable across the health grid and dependent service health checks.

---

## Configuration Reference

All configuration is via environment variables, set in `docker-compose.yml`.

| Service | Variable | Default | Description |
|---|---|---|---|
| All | `PORT` | (varies) | HTTP listen port |
| Identity Provider | `JWT_SECRET` | `dev-secret` | Signing key for JWT tokens |
| Order Gateway | `JWT_SECRET` | `dev-secret` | Must match Identity Provider |
| Order Gateway | `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| Order Gateway | `STOCK_SERVICE_URL` | `http://localhost:3003` | Stock Service base URL |
| Order Gateway | `KITCHEN_QUEUE_URL` | `http://localhost:3004` | Kitchen Queue base URL |
| Order Gateway | `NOTIFICATION_HUB_URL` | `http://localhost:3005` | Notification Hub base URL |
| Stock Service | `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| Kitchen Queue | `RABBITMQ_URL` | `amqp://cafeteria:iftar2024@localhost:5672` | RabbitMQ AMQP URL |
| Kitchen Queue | `NOTIFICATION_HUB_URL` | `http://localhost:3005` | Notification Hub base URL |

---

## Development Guide

### Adding a new menu item

Edit `MENU_ITEMS` in `stock-service/src/index.js`. Also add the item ID to `VALID_ITEMS` in `order-gateway/src/orderValidation.js`. Rebuild both services:

```bash
docker compose up --build stock-service order-gateway
```

### Changing stock default quantity

Edit the `initializeStock` function in `stock-service/src/index.js`. Note: stock is only seeded if the Redis key doesn't exist. To force a re-seed, flush Redis first:

```bash
docker compose exec redis redis-cli FLUSHALL
docker compose restart stock-service
```

### Running without Docker (local development)

Start Redis and RabbitMQ separately (e.g., via Docker), then:

```bash
# Terminal 1
cd identity-provider && npm install && JWT_SECRET=dev PORT=3001 node src/index.js

# Terminal 2
cd stock-service && npm install && REDIS_URL=redis://localhost:6379 PORT=3003 node src/index.js

# Terminal 3
cd notification-hub && npm install && PORT=3005 node src/index.js

# Terminal 4
cd kitchen-queue && npm install && RABBITMQ_URL=amqp://cafeteria:iftar2024@localhost:5672 NOTIFICATION_HUB_URL=http://localhost:3005 PORT=3004 node src/index.js

# Terminal 5
cd order-gateway && npm install && JWT_SECRET=dev REDIS_URL=redis://localhost:6379 STOCK_SERVICE_URL=http://localhost:3003 KITCHEN_QUEUE_URL=http://localhost:3004 NOTIFICATION_HUB_URL=http://localhost:3005 PORT=3002 node src/index.js
```

Then open `frontend/index.html` directly in your browser.

### Demo credentials

| Student ID | Password | Role |
|---|---|---|
| STU001 | iftar2024 | student |
| STU002 | iftar2024 | student |
| STU003 | iftar2024 | student |
| admin | admin2024 | admin |


### AI Usage
ChatGPT for helping to strategize
Claude Code for Code Base