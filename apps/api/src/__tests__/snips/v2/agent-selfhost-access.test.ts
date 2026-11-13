import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../config";
import {
  describeIf,
  HAS_AI,
  Identity,
  idmux,
  scrapeTimeout,
  TEST_API_URL,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
} from "../lib";

// Community self-host: with no Bigtable job access table, agent status,
// cancel, trace, skill and snapshot authorize a run from the agent service's
// own status (teamId/createdAt). These cases need a self-hosted API with
// EXTRACT_V3_BETA_URL pointing at a running agent service (for example
// apps/agent-community via community/docker-compose.agent.yaml). A run drives
// a model, so the AI gate from AGENTS.md applies too.
const RUNS =
  TEST_SELF_HOST &&
  HAS_AI &&
  !!config.EXTRACT_V3_BETA_URL &&
  !config.BIGTABLE_JOB_ACCESS_TABLE;

const RUN_TIMEOUT = scrapeTimeout * 4;

let identity: Identity;

beforeAll(async () => {
  if (!RUNS) return;
  identity = await idmux({ name: "agent-selfhost-access", credits: 100000 });
}, scrapeTimeout);

const api = () => ({
  get: (path: string) =>
    request(TEST_API_URL)
      .get(path)
      .set("Authorization", `Bearer ${identity.apiKey}`),
  del: (path: string) =>
    request(TEST_API_URL)
      .delete(path)
      .set("Authorization", `Bearer ${identity.apiKey}`),
  post: (path: string, body: Record<string, unknown>) =>
    request(TEST_API_URL)
      .post(path)
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send(body),
});

describeIf(RUNS)("Agent job access without Bigtable", () => {
  it(
    "starts a run and reads it back through status and trace",
    async () => {
      const start = await api().post("/v2/agent", {
        prompt: "What is the main heading of this page?",
        urls: [TEST_SUITE_WEBSITE],
        strictConstrainToURLs: true,
        effort: "low",
        schema: {
          type: "object",
          properties: { heading: { type: "string" } },
          required: ["heading"],
        },
      });
      expect(start.statusCode).toBe(200);
      expect(start.body.success).toBe(true);
      expect(typeof start.body.id).toBe("string");

      const deadline = Date.now() + RUN_TIMEOUT - scrapeTimeout;
      let status: any;
      for (;;) {
        const res = await api().get(`/v2/agent/${start.body.id}`);
        expect(res.statusCode).toBe(200);
        status = res.body;
        if (status.status !== "processing") break;
        if (Date.now() > deadline) throw new Error("agent run did not finish");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      expect(status.success).toBe(true);
      expect(status.status).toBe("completed");
      expect(typeof status.data.heading).toBe("string");
      expect(typeof status.expiresAt).toBe("string");

      const trace = await api().get(`/v2/agent/${start.body.id}/trace`);
      expect(trace.statusCode).toBe(200);
      expect(Array.isArray(trace.body.events)).toBe(true);

      const cancel = await api().del(`/v2/agent/${start.body.id}`);
      expect(cancel.statusCode).toBe(409);
    },
    RUN_TIMEOUT,
  );

  it(
    "answers 404 for a run owned by another team",
    async () => {
      // Seed a run for a different team straight into the agent service, as
      // another team's POST /v2/agent would.
      const id = uuidv7();
      const seeded = await fetch(
        `${config.EXTRACT_V3_BETA_URL!.replace(/\/$/, "")}/internal/extracts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}`,
          },
          body: JSON.stringify({
            id,
            teamId: "00000000-0000-4000-8000-0000000000aa",
            prompt: "Owned by another team",
            urls: [TEST_SUITE_WEBSITE],
            strictConstrainToURLs: true,
            model: "spark-2",
            effort: "low",
          }),
        },
      );
      expect(seeded.status).toBe(200);

      for (const path of [
        `/v2/agent/${id}`,
        `/v2/agent/${id}/trace`,
        `/v2/agent/${id}/skill`,
        `/v2/agent/${id}/snapshots/${uuidv7()}`,
      ]) {
        const res = await api().get(path);
        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
      }
      const cancel = await api().del(`/v2/agent/${id}`);
      expect(cancel.statusCode).toBe(404);

      const missing = await api().get(`/v2/agent/${uuidv7()}`);
      expect(missing.statusCode).toBe(404);

      // Clean up the seeded run.
      await fetch(
        `${config.EXTRACT_V3_BETA_URL!.replace(/\/$/, "")}/internal/extracts/${id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${config.AGENT_INTEROP_SECRET}` },
        },
      );
    },
    scrapeTimeout,
  );
});
