import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { connectRedis } from './redis';
import { checkRateLimit, RateLimiterResult } from './rateLimiter';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Load limits configuration from JSON file
const limitsPath = path.join(__dirname, '../limits.json');
let limitsConfig: Record<string, { limit: number; window_seconds: number }> = {};

try {
  const data = fs.readFileSync(limitsPath, 'utf8');
  limitsConfig = JSON.parse(data);
  console.log('Loaded limits.json configuration');
} catch (err) {
  console.error('Failed to load limits.json, using fallback defaults', err);
  limitsConfig = { default: { limit: 10, window_seconds: 60 } };
}

// Utility to set standard rate limit headers
function setRateLimitHeaders(res: Response, result: RateLimiterResult, limit: number) {
  res.setHeader('X-RateLimit-Limit', limit.toString());
  res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining).toString());
}

// Global Redis client
let redisClient: Awaited<ReturnType<typeof connectRedis>>;

app.post('/check', async (req: Request, res: Response) => {
  const { client_id } = req.body;

  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }

  // Get the limit for this user, or use the default
  const config = limitsConfig[client_id] || limitsConfig['default'];

  try {
    const result = await checkRateLimit(redisClient, client_id, config.limit, config.window_seconds);
    
    setRateLimitHeaders(res, result, config.limit);

    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        ...result,
      });
    }

    return res.json({
      message: 'Request allowed',
      ...result,
    });
  } catch (err: any) {
    console.error('Rate Limiter Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/health', (req: Request, res: Response) => {
  if (redisClient?.isReady) {
    res.send('OK');
  } else {
    res.status(503).send('Redis Unavailable');
  }
});

async function main() {
  redisClient = await connectRedis();

  app.listen(PORT, () => {
    console.log(`Rate limiter API running on port ${PORT}`);
  });
}

main().catch(console.error);
