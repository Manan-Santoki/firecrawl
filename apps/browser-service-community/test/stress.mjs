const baseUrl = (process.env.BROWSER_STRESS_URL ?? "http://127.0.0.1:39006").replace(/\/$/, "");
const apiKey = process.env.BROWSER_STRESS_API_KEY ?? "ci-browser-key";
const rounds = Number(process.env.BROWSER_STRESS_ROUNDS ?? 15);
const concurrency = Number(process.env.BROWSER_STRESS_CONCURRENCY ?? 2);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("BROWSER_STRESS_ROUNDS must be positive");
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("BROWSER_STRESS_CONCURRENCY must be positive");
}

const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

async function request(path, init, label) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON (${response.status}): ${text}`);
  }
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text}`);
  return body;
}

async function cycle(label) {
  let sessionId;
  try {
    const created = await request(
      "/browsers",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ttl: 60, activityTtl: 30, record: false }),
      },
      `create ${label}`,
    );
    sessionId = created.sessionId;
    if (typeof sessionId !== "string") throw new Error(`create ${label} omitted sessionId`);

    const executed = await request(
      `/browsers/${encodeURIComponent(sessionId)}/exec`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          language: "node",
          code: 'await page.setContent("<title>community-stress</title>"); return await page.title();',
          timeout: 20,
        }),
      },
      `execute ${label}`,
    );
    if (executed.exitCode !== 0 || executed.result !== "community-stress") {
      throw new Error(`execute ${label} returned an invalid result: ${JSON.stringify(executed)}`);
    }
  } finally {
    if (sessionId) {
      await request(
        `/browsers/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers },
        `delete ${label}`,
      );
    }
  }
}

for (let round = 0; round < rounds; round += 1) {
  await Promise.all(Array.from({ length: concurrency }, (_, index) => cycle(`${round}-${index}`)));
  await new Promise(resolve => setTimeout(resolve, 250));
}

const readiness = await request("/health/readiness", undefined, "readiness");
if (readiness.activeSessions !== 0) {
  throw new Error(`Stress run leaked ${readiness.activeSessions} active session(s)`);
}
console.log(JSON.stringify({ success: true, rounds, concurrency, sessions: rounds * concurrency }));
