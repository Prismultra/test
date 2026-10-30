// Vercel Function: set https://<your-app>.vercel.app/api/interactions as the
// Interactions Endpoint URL in the Discord Developer Portal.
import { waitUntil } from "@vercel/functions";
import { handleRequest } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Deps } from "../src/discord/context.js";
import { createDeps } from "../src/runtime.js";

let deps: Deps | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      deps ??= createDeps(loadConfig(), waitUntil);
    } catch (err) {
      console.error(err);
      return new Response(`Tavernkeep is misconfigured: ${(err as Error).message}`, { status: 500 });
    }
    return handleRequest(request, deps);
  },
};
