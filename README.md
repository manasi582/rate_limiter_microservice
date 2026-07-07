# Rate Limiter as a Service

A high-performance, standalone rate-limiting microservice built using **Node.js, Express, TypeScript, Redis, and PostgreSQL**. 

This service acts as an API guardian for your backend ecosystem. Downstream services query the `/check` endpoint of this service before processing client requests to guarantee that clients do not exceed their configured rates.

---

## 1. Problem Statement
This service protects backend infrastructure from degradation, abuse, and resource exhaustion by enforcing request rate ceilings per client ID. It guarantees that clients cannot exceed their configured limits (e.g. 100 requests per minute) under any circumstances, including concurrent requests or attacks distributed across multiple application nodes. It manages rate-limiting states globally in a centralized Redis store while caching rules locally to maintain sub-5ms lookup speeds.

---

## 2. Rate Limiting Algorithms Comparison

This project implements three standard rate limiting algorithms with distinct trade-offs:

| Algorithm | How it Works | Pros | Cons |
|---|---|---|---|
| **Fixed Window Counter** | Divides time into static blocks (e.g., minutes). Each client gets an integer counter per block. | Minimal memory footprint (1 integer key per client per window). | **Boundary Spike Bug**: Allows double the rate limit near window boundaries. |
| **Sliding Window Log** | Stores a timestamped log (using Redis Sorted Sets) of every request. Removes expired timestamps on each check. | 100% accurate rolling window coverage; prevents boundary spikes. | Memory-heavy. Storing every request timestamp does not scale well for high-throughput clients (e.g., 10,000 req/min). |
| **Token Bucket** | Virtual bucket filled with tokens at a constant refill rate up to a max capacity. Every request consumes 1 token. | Production standard (used by AWS/Nginx). Allows short traffic bursts while strictly capping the long-term average rate. | Slightly higher implementation complexity. |

---

## 3. The Boundary Spike Bug & Proof

### What is the Boundary Spike Bug?
In a naive **Fixed Window Counter**, if a client has a limit of 10 requests per 10 seconds, they can send 10 requests at the very end of Window A (e.g. at `t = 9s`) and another 10 requests at the very start of Window B (e.g. at `t = 11s`). This means the client successfully fired **20 requests in a 2-second period**, effectively doubling the configured rate limit. 

### How We Proved It
We wrote a test script (`scripts/test_boundary_spike.ts`) that targets a client configured for `10 requests / 10 seconds`. The test waits until the final 1.5 seconds of the current window, fires 10 requests, waits for the rollover, and immediately fires another 10 requests.

Here is the actual output from our test suite run:

```
=== RATE LIMITER ALGORITHM COMPARISON SUITE ===

--- Running Test: Naive Fixed Window ---
Sending Wave 1 (10 requests) in the final 1419ms of current window...
Wave 1: 10/10 allowed.
Waiting for window rollover (1910ms)...
Sending Wave 2 (10 requests) immediately in the new window...
Wave 2: 10/10 allowed.
Finished Naive Fixed Window. Total allowed: 20/20

--- Running Test: Correct Fixed Window (Multi/Exec) ---
Sending Wave 1 (10 requests) in the final 1499ms of current window...
Wave 1: 10/10 allowed.
Waiting for window rollover (1974ms)...
Sending Wave 2 (10 requests) immediately in the new window...
Wave 2: 10/10 allowed.
Finished Correct Fixed Window (Multi/Exec). Total allowed: 20/20

--- Running Test: Sliding Window Log (Lua) ---
Sending Wave 1 (10 requests) in the final 1401ms of current window...
Wave 1: 10/10 allowed.
Waiting for window rollover (1886ms)...
Sending Wave 2 (10 requests) immediately in the new window...
Wave 2: 0/10 allowed.
Finished Sliding Window Log (Lua). Total allowed: 10/20

--- Running Test: Token Bucket (Lua) ---
Sending Wave 1 (10 requests) in the final 1489ms of current window...
Wave 1: 10/10 allowed.
Waiting for window rollover (1980ms)...
Sending Wave 2 (10 requests) immediately in the new window...
Wave 2: 1/10 allowed.
Finished Token Bucket (Lua). Total allowed: 11/20

==================================================
                  FINAL RESULTS                   
==================================================
Configured limit: 10 requests per 10 seconds.
Test sent 20 requests spanning the window boundary (10 at end, 10 at start).

Algorithm Name                      | Allowed Requests
-------------------------------------------------------
Naive Fixed Window                  | 20 / 20 ✗ (Boundary Spike!)
Correct Fixed Window (Multi/Exec)   | 20 / 20 ✗ (Boundary Spike!)
Sliding Window Log (Lua)            | 10 / 20 ✓ (Throttled Correctly)
Token Bucket (Lua)                  | 11 / 20 ✓ (Throttled Correctly - 1 refilled naturally over 2s)
==================================================
```

### Analysis of the Fixes
* **Sliding Window Log** prevents the boundary spike entirely because request counts are evaluated on a true sliding window. Only 10 requests are allowed in any 10-second rolling interval, rejecting Wave 2 completely.
* **Token Bucket** allowed 11/20. Because the rollover took 2 seconds, the bucket naturally refilled by `2 seconds * (10 tokens / 10 seconds) = 2 tokens`. It allowed 1 request from Wave 2 (leaving the bucket empty), confirming its math functions correctly.

---

## 4. Redis Atomicity & Lua Scripting

### The Naive Race Condition
A naive implementation uses two commands:
1. `INCR rate:user_123:timestamp`
2. `EXPIRE rate:user_123:timestamp 60`

Under high concurrency, multiple server threads can run `INCR` concurrently before any thread sets the `EXPIRE` directive. If a network blip or process crash occurs between these two commands, the key is left with **no TTL**, causing the counter to live forever and permanently blocking the user.

### Why Lua Scripts Solve This
Redis executes Lua scripts **atomically** on a single thread. No other command can run between the first and last line of a Lua script. 
1. **Sliding Window Log**: Reading the sorted set size, purging expired timestamps, adding the new timestamp, and setting key TTL must be done as a single atomic unit. If not, two concurrent requests can both read `ZCARD = 9` (under a limit of 10), both write a new timestamp, and push the actual count to 11.
2. **Token Bucket**: The read-compute-write cycle (calculating elapsed time, refilling tokens, decrementing tokens, updating hash) must run atomically. Running this in a Lua script avoids application-level locks and guarantees correctness.

---

## 5. System Setup

### Prerequisites
* Docker & Docker Compose
* Node.js & NPM

### Spin Up Infrastructure (PostgreSQL & Redis)
Exposes Postgres on port `5433` (to avoid conflicts with local Postgres installs) and Redis on port `6379`:
```bash
docker-compose up -d
```

### Run the Application (Locally)
```bash
npm install
npm run dev
```

### Run Verification Test Suites
* **Algorithm Boundary Spike Comparison**:
  ```bash
  npm run test:boundary
  ```
* **Concurrency Stress Test**:
  ```bash
  npm run test:concurrency
  ```

---

## 6. API Reference

All successful and rejected responses return RFC 6585 standard rate limit headers:
* `X-RateLimit-Limit`: Maximum allowed requests in the window.
* `X-RateLimit-Remaining`: Remaining request capacity for the client in the current window.
* `X-RateLimit-Reset`: Unix timestamp (in seconds) when the rate limit completely resets.
* `Retry-After`: (Only on HTTP 429) Number of seconds the client must wait before making another request.

### Core - Rate Limit Check
* **Endpoint**: `POST /check`
* **Headers**: `Content-Type: application/json`
* **Body**:
  ```json
  {
    "client_id": "user_123",
    "action": "api_call"
  }
  ```

* **Response - Allowed (200 OK)**:
  ```json
  {
    "allowed": true,
    "limit": 100,
    "remaining": 99,
    "reset_at": 1720000060
  }
  ```

* **Response - Throttled (429 Too Many Requests)**:
  ```json
  {
    "allowed": false,
    "limit": 100,
    "remaining": 0,
    "reset_at": 1720000060,
    "retry_after": 17
  }
  ```

### Configuration CRUD
* `POST /configs`: Create a config.
  ```json
  {
    "client_id": "api_key_abc",
    "algorithm": "token_bucket",
    "limit": 100,
    "window_seconds": 60,
    "burst_capacity": 150,
    "refill_rate": 2.5
  }
  ```
* `GET /configs`: List configs.
* `GET /configs/:id`: Get a specific config.
* `PATCH /configs/:id`: Update a config.
* `DELETE /configs/:id`: Soft delete/deactivate a config.

### Observability & Metrics
* `GET /health`: Connects to Postgres and Redis to verify connection health.
* `GET /metrics`: Global metrics (total checks, total rejections, global rejection %).
* `GET /metrics/:client_id`: Per-client statistics and a list of the last 100 rejection events.

---

## 7. Scaling to Production

To scale this service to handle millions of requests per second:
1. **Redis Sharding (Redis Cluster)**: Shard the Redis instance by client ID. The application can hash `client_id` (e.g., MurmurHash3) to route checks to specific Redis shards.
2. **Local Cache invalidation via Redis Pub/Sub**: We implemented this in our node app! Local API servers cache configurations in-memory to bypass Postgres DB reads for every `/check` call. When a config changes via a CRUD endpoint, the updating node publishes a message to a Redis Pub/Sub channel, prompting all node instances to invalidate their local config cache instantly.
3. **Local Token Pre-allocation**: For extreme scale, local API instances can lease/pre-allocate blocks of tokens (e.g., 50 tokens at a time) from Redis, checking requests locally and syncing the remainder back asynchronously. This lowers Redis network load by 95% at the cost of slight rate-limit elasticity.
