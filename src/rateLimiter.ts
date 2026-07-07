import { createClient } from 'redis';

// Redis Lua script for an atomic Sliding Window Log algorithm.
// We use a Sorted Set (ZSET) where the score is the timestamp, and the value is a unique request ID.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local current_time = tonumber(ARGV[3])
local request_id = ARGV[4]

-- Remove all requests that are older than the current window
local min_time = current_time - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', min_time)

-- Count how many requests are still in the window
local count = redis.call('ZCOUNT', key, '-inf', '+inf')

if count >= limit then
  -- Rate limit exceeded
  return { 0, limit - count }
else
  -- Allow request: add the new unique request ID to the set with the current time as the score
  redis.call('ZADD', key, current_time, request_id)
  -- Set an expiry on the whole set to clean up inactive users
  redis.call('PEXPIRE', key, window_ms)
  return { 1, limit - (count + 1) }
end
`;

export interface RateLimiterResult {
  allowed: boolean;
  remaining: number;
}

export async function checkRateLimit(
  redisClient: ReturnType<typeof createClient>,
  clientId: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimiterResult> {
  const key = `rate_limit:sliding_log:${clientId}`;
  const nowMs = Date.now();
  const windowMs = windowSeconds * 1000;
  
  // Create a truly unique ID for this specific request so they don't overwrite each other in Redis
  const uniqueRequestId = `${nowMs}-${Math.random().toString(36).substring(2, 9)}`;

  // Execute the Lua script atomically
  const result = await redisClient.executeIsolated(async (isolatedClient) => {
    return await isolatedClient.eval(SLIDING_WINDOW_LUA, {
      keys: [key],
      arguments: [limit.toString(), windowMs.toString(), nowMs.toString(), uniqueRequestId],
    });
  }) as [number, number];

  return {
    allowed: result[0] === 1,
    // Redis Lua script calculates remaining based on count. 
    // If we exceed limit, it might be negative depending on math, so we bound it to 0.
    remaining: Math.max(0, result[1]),
  };
}
