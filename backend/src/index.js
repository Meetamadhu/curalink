import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { connectDb } from "./config/db.js";
import { chatRouter } from "./routes/chat.js";

const PORT = Number(process.env.PORT || 5000);
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/curalink";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await connectDb(MONGODB_URI);
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "curalink-backend" });
  });

  app.use("/api/chat", chatRouter);

  const dist = process.env.FRONTEND_DIST?.trim();
  if (dist) {
    const abs = path.isAbsolute(dist) ? dist : path.resolve(process.cwd(), dist);
    if (fs.existsSync(abs)) {
      app.use(express.static(abs));
      app.use((req, res, next) => {
        if (req.path.startsWith("/api")) return next();
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        res.sendFile(path.join(abs, "index.html"), (err) => next(err));
      });
      console.log(`Serving SPA from ${abs}`);
    } else {
      console.warn(`FRONTEND_DIST set but not found: ${abs}`);
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Curalink API listening on 0.0.0.0:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
