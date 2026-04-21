import express from "express";
import { createRequestHandler } from "@remix-run/express";
import path from "path";

const app = express();

// Global CORS preflight handler for /api routes.
// This intercepts OPTIONS at the Express level so CORS works regardless of
// how Remix routes non-GET methods internally.
app.use("/api", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }

  next();
});

// Static assets from the Remix client build
const BUILD_CLIENT = path.join(process.cwd(), "build/client");
app.use("/assets", express.static(path.join(BUILD_CLIENT, "assets"), { immutable: true, maxAge: "1y" }));
app.use(express.static(BUILD_CLIENT, { maxAge: "1h" }));

// Remix handles everything else
// eslint-disable-next-line @typescript-eslint/no-var-requires
const build = require("./build/server/index.js");
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
