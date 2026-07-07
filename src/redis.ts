import { createClient } from 'redis';

export async function connectRedis() {
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  
  client.on('error', (err) => console.error('Redis Client Error', err));
  
  await client.connect();
  console.log('Connected to Redis');
  return client;
}
