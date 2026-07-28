const URL = "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js";
function rss() { return Math.round(process.memoryUsage().rss / 1024); }
const N = Number(process.env.N ?? 500);
const WARMUP = 50;

async function fetchWithRetry(url: string): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      lastErr = new Error(`status ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 100 * (i + 1)));
  }
  throw lastErr;
}

async function measure(label: string, action: (r: Response) => Promise<void>) {
  const held: Response[] = [];
  for (let i = 0; i < WARMUP; i++) {
    const r = await fetchWithRetry(URL);
    await r.arrayBuffer();
  }
  const r0 = rss();
  for (let i = 0; i < N; i++) {
    const r = await fetchWithRetry(URL);
    await action(r);
    held.push(r);
  }
  const r1 = rss();
  console.log(JSON.stringify({
    label,
    N,
    r0,
    r1,
    delta_kb: r1 - r0,
    per_req_kb: Number(((r1 - r0) / N).toFixed(2)),
  }));
  return held;
}

const results: any[] = [];
results.push(await measure("consume", async r => { await r.arrayBuffer(); }));
results.push(await measure("cancel-body", async r => { await r.body?.cancel(); }));
results.push(await measure("held", async r => { /* do nothing */ }));
