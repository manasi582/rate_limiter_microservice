import axios from 'axios';

const API_URL = 'http://localhost:3000';
const CLIENT_ID = "user_456" //+ Date.now(); // use a fresh user for clean test

// Based on the 'default' configuration in limits.json, this user gets 5 requests per 10 seconds.
const LIMIT = 10;
const WINDOW_SECS = 10;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRequest(requestNumber: number) {
  try {
    const res = await axios.post(`${API_URL}/check`, {
      client_id: CLIENT_ID,
    });
    console.log(`Request ${requestNumber}: [${res.status}] ALLOWED (Remaining: ${res.data.remaining})`);
    return true;
  } catch (err: any) {
    if (err.response && err.response.status === 429) {
      console.log(`Request ${requestNumber}: [${err.response.status}] BLOCKED (Remaining: 0)`);
      return false;
    }
    console.error(`Request ${requestNumber}: ERROR`, err.message);
    return false;
  }
}

async function runTest() {
  console.log(`=== RATE LIMITER TEST ===`);
  console.log(`Using Sliding Window Log algorithm via Redis.`);
  console.log(`Limit: ${LIMIT} requests per ${WINDOW_SECS} seconds.\n`);

  console.log(`--- Firing ${LIMIT} requests (should all be allowed) ---`);
  for (let i = 1; i <= LIMIT; i++) {
    await sendRequest(i);
  }

  console.log(`\n--- Firing 2 more requests immediately (should be blocked) ---`);
  await sendRequest(LIMIT + 1);
  await sendRequest(LIMIT + 2);

  console.log(`\n--- Waiting for window to expire (${WINDOW_SECS} seconds) ---`);
  await sleep(WINDOW_SECS * 1000 + 500);

  console.log(`\n--- Firing 1 request in new window (should be allowed) ---`);
  await sendRequest(LIMIT + 3);

  console.log(`\nTest complete!`);
}

runTest().catch(console.error);
