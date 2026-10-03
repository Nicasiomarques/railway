import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FastifyPluginAsync } from "fastify";

// Interactive documentation with Stoplight Elements, reading /openapi.json.
// We only serve the two bundle files: the whole package should not be exposed.
const require = createRequire(import.meta.url);
const elementsDir = dirname(require.resolve("@stoplight/elements"));

const PAGE = `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Railway-like API</title>
    <link rel="stylesheet" href="/docs/assets/styles.min.css" />
    <script src="/docs/assets/web-components.min.js"></script>
  </head>
  <body>
    <elements-api apiDescriptionUrl="/openapi.json" router="hash" layout="sidebar" />
  </body>
</html>
`;

export const docsRoutes: FastifyPluginAsync = async (app) => {
  const assets = {
    "styles.min.css": { type: "text/css", body: await readFile(join(elementsDir, "styles.min.css")) },
    "web-components.min.js": {
      type: "application/javascript",
      body: await readFile(join(elementsDir, "web-components.min.js")),
    },
  };

  app.get("/docs", async (_request, reply) => reply.type("text/html; charset=utf-8").send(PAGE));

  app.get<{ Params: { file: string } }>("/docs/assets/:file", async (request, reply) => {
    const asset = assets[request.params.file as keyof typeof assets];
    if (!asset) return reply.code(404).send();
    return reply.type(asset.type).header("cache-control", "public, max-age=86400").send(asset.body);
  });
};
