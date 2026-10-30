// Local development server. Run with `npm run dev`, expose it with a tunnel
// (e.g. `cloudflared tunnel --url http://localhost:3000`) and set the tunnel URL
// as the Interactions Endpoint URL in the Discord Developer Portal.
import { createServer } from "node:http";
import { handleRequest } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDeps } from "../src/runtime.js";

const port = Number(process.env.PORT ?? 3000);
const deps = createDeps(loadConfig(), (p) => void p.catch((err) => console.error("background task failed", err)));

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://localhost:${port}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
  });
  const response = await handleRequest(request, deps);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`Tavernkeep listening on http://localhost:${port}`);
  console.log(`AI Dungeon Master: ${deps.dm ? `on — ${deps.dm.label ?? "custom model"}` : "off (set ANTHROPIC_API_KEY or GROQ_API_KEY)"}`);
});
