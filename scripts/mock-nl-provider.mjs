// Loopback-only fixture for browser confirmation and provider-failure capture.
import { createServer } from "node:http";

const port = Number(process.env.PORT || 3109);
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = messages.at(-1)?.content;
    if (prompt === "learners who barely made any progress") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"maxProgressPct":15}' } }] }));
    } else {
      res.writeHead(503).end();
    }
  } catch {
    res.writeHead(400).end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Test-only mock at http://127.0.0.1:${port}/v1`));
