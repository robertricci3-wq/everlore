import { isRecoveryLocked } from "./recovery-lock.js";
import { installAlmanacRoutes } from "./almanac/routes.js";
import { interviewRecovery } from "./almanac/transcription.js";
import { installOperatorCostRoutes } from "./costs/routes.js";
import { assertSupportedCostPlan } from "./engine/request-cost.js";
import { legacyImageRender } from "../shared/imageRender.js";
import {
  installCommercePublic,
  installCommerceRoutes,
  installCommerceOperatorRoutes,
} from "./commerce/routes.js";
import { publicOrigin, allowedHost } from "./hosting.js";
import {
  AccessError,
  configureAccess,
  operatorId,
  requireOperator,
  accessView,
  issueInvitation,
  revokeInvitation,
  redeemInvitation,
} from "./access.js";
import { artSvg } from "../shared/art.js";
import { installLabRoutes } from "./lab/routes.js";
import { labOwner } from "./lab/service.js";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import {
  Approval,
  Book,
  Correction,
  Credentials,
  Login,
  ManualTranscript,
  RevisionRequest,
  Transcript,
} from "../shared/contracts.js";
import { exportArchive, restoreArchive } from "./archive.js";
import { sampleSource, sampleBook } from "../shared/fixture.js";
import { Store, canonical, hash, id, now, type ProjectRow } from "./store.js";
import { queueSample, renamePerson } from "./pipeline.js";
import { renderPdf } from "./layout.js";
import {
  engineConfig,
  availability,
  type EngineConfig,
} from "./engine/provider.js";
import {
  queueEngine,
  engineView,
  confirmEngineSource,
  approveEngineArt,
  EngineError,
} from "./engine/pipeline.js";

import {
  queueStudio,
  studioView,
  latestStudio,
  confirmStudioSource,
  confirmStudioHeart,
  approveStudioCast,
  approveStudioArt,
  queueRepair,
  changeDirection,
  familyVersions,
} from "./engine/studio.js";

import {
  setupView,
  familySetupView,
  saveVerifiedStudioConnection,
  checkSavedStudioConnection,
} from "./engine/setup.js";
import { resumeStudio, studioRecovery } from "./engine/recovery.js";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const requireValue = <T>(
  value: T | undefined,
  message = "We could not find that story.",
): T => {
  if (!value) throw new HttpError(404, message);
  return value;
};
type User = { id: string; name: string; kind: string; password: string };
export function createApp(
  store: Store,
  config: EngineConfig = engineConfig(),
  connectionRequest: typeof fetch = fetch,
  hostingOrigin: string | null = publicOrigin(),
) {
  configureAccess(store, !!hostingOrigin);
  const app = express();
  // The service is reachable only through the configured single ingress proxy.
  // Express takes the nearest forwarded address, never an arbitrary leftmost one.
  app.set("trust proxy", hostingOrigin ? 1 : false);
  app.disable("x-powered-by");
  const users = new WeakMap<Request, User>();
  const attempts = new Map<string, { count: number; until: number }>();
  app.use((req, res, next) => {
    if (req.path === "/healthz" || req.path === "/readyz") return next();
    const port = req.socket.localPort;
    if (!allowedHost(req.headers.host ?? "", port, hostingOrigin))
      return res
        .status(403)
        .json({ error: "Use the configured Everlore address." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.path !== "/api/payments/stripe/webhook"
      ) {
        if (req.headers["x-evermore-client"] !== "1")
          return res
            .status(403)
            .json({ error: "Please reopen Everlore and try again." });
        if (
          req.headers.origin &&
          req.headers.origin !== (hostingOrigin ?? `http://${req.headers.host}`)
        )
          return res
            .status(403)
            .json({ error: "This request did not come from Everlore." });
      }
      if (req.headers["sec-fetch-site"] === "cross-site")
        return res
          .status(403)
          .json({ error: "Please open Everlore directly." });
    }
    next();
  });
  installCommercePublic(app, store);
  app.use(express.json({ limit: "100kb" }));
  const tokenFrom = (req: Request) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("evermore="))
      ?.slice(9);
  const findUser = (req: Request) => {
    const token = tokenFrom(req);
    return token
      ? store.one<User>(
          "SELECT users.* FROM users JOIN sessions ON users.id=sessions.userId WHERE tokenHash=? AND expires>?",
          hash(token),
          Date.now(),
        )
      : undefined;
  };
  const establish = (res: Response, userId: string) => {
    const token = randomBytes(32).toString("hex");
    store.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      userId,
      Date.now() + 30 * 86400000,
    );
    res.cookie("evermore", token, {
      httpOnly: true,
      secure: !!hostingOrigin,
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 86400000,
    });
  };
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    const user = findUser(req);
    if (!user)
      throw new HttpError(401, "Please open your private shelf first.");
    users.set(req, user);
    next();
  };
  const owner = (req: Request) => requireValue(users.get(req));
  const operatorGuard = (req: Request, _res: Response, next: NextFunction) => {
    const user = findUser(req);
    if (!user)
      throw new HttpError(401, "Please open your private shelf first.");
    users.set(req, user);
    requireOperator(store, user.id);
    next();
  };
  const project = (req: Request) => {
    const p = requireValue(
      store.one<ProjectRow>(
        "SELECT * FROM projects WHERE id=? AND ownerId=?",
        String(req.params.id),
        owner(req).id,
      ),
    );
    if (
      req.method !== "GET" &&
      store.one("SELECT id FROM lab_runs WHERE projectId=?", p.id)
    )
      throw new HttpError(
        409,
        "Lab artifacts are frozen experiment evidence. Create a new experiment to change them.",
      );
    if (req.method !== "GET" && store.one("SELECT id FROM almanac_sessions WHERE projectId=?", p.id))
      throw new HttpError(409, "Open this memory in your almanac to add to it or make its story.");
    return p;
  };
  const currentBook = (p: ProjectRow) =>
    Book.parse(
      JSON.parse(
        requireValue(
          store.one<{ book: string }>(
            "SELECT book FROM revisions WHERE projectId=? AND revision=?",
            p.id,
            p.revision,
          ),
        ).book,
      ),
    );
  const authLimit = (req: Request, _res: Response, next: NextFunction) => {
    for (const [address, record] of attempts)
      if (record.until <= Date.now()) attempts.delete(address);
    const key = req.ip ?? req.socket.remoteAddress ?? "local",
      previous = attempts.get(key),
      item =
        previous && previous.until > Date.now()
          ? previous
          : { count: 0, until: Date.now() + 60000 };
    item.count++;
    attempts.set(key, item);
    if (item.count > 20)
      throw new HttpError(
        429,
        "There have been many sign-in attempts. Please wait a minute.",
      );
    next();
  };
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", (_req, res) => {
    let ready = !app.locals.draining && !isRecoveryLocked(store);
    try {
      store.one("SELECT 1 AS ok");
    } catch {
      ready = false;
    }
    if (hostingOrigin && !operatorId(store)) ready = false;
    res.status(ready ? 200 : 503).json({ ready });
  });
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      storage: "local-sqlite",
      version: 1,
      providers: {
        transcription: availability(config).ready
          ? "configured"
          : "unavailable",
        text: availability(config).ready ? "configured" : "unavailable",
        image: availability(config).ready ? "configured" : "unavailable",
      },
      engine: availability(config),
      liveSpendUsd: store.one("SELECT runId FROM engine_budget LIMIT 1")
        ? null
        : 0,
    }),
  );
  app.get("/api/engine", (_req, res) => {
    let ready = availability(config).ready && process.env.DISABLE_WORKER !== "1" && !isRecoveryLocked(store);
    if (ready && config.strictCostGuard) {
      try { assertSupportedCostPlan({ text: config.textModel, image: config.imageModel, audio: config.audioModel }, config.imageRender ?? legacyImageRender(config.imageModel)); }
      catch { ready = false; }
    }
    res.json({ ready, message: ready ? "Ready when you are. Everlore takes care of making your book." : "You can save a memory now. Story creation is not available yet; your recording will be kept safely." });
  });
  app.get("/api/session", (req, res) => {
    const user = findUser(req);
    res.json({
      hosted: !!hostingOrigin,
      inviteRequired: !!hostingOrigin,
      operatorConfigured: !!operatorId(store),
      user: user
        ? {
            id: user.id,
            name: user.name,
            kind: user.kind,
            labOwner: labOwner(store) === user.id,
            operator: operatorId(store) === user.id,
          }
        : null,
    });
  });
  app.post("/api/register", authLimit, (req, res) => {
    const body = Credentials.parse(req.body),
      name = body.name.toLowerCase();
    if (store.one("SELECT id FROM users WHERE name=?", name))
      throw new HttpError(
        409,
        "That shelf name is already taken. Sign in, or choose another.",
      );
    const userId = id(),
      salt = randomBytes(16).toString("hex"),
      password = scryptSync(body.password, salt, 64).toString("hex");
    store.transaction(() => {
      store.run(
        "INSERT INTO users VALUES(?,?,?,?,?)",
        userId,
        name,
        `${salt}:${password}`,
        "private",
        now(),
      );
      if (hostingOrigin) redeemInvitation(store, req.body.inviteCode, userId);
    });
    const old = tokenFrom(req);
    if (old) store.run("DELETE FROM sessions WHERE tokenHash=?", hash(old));
    establish(res, userId);
    res.status(201).json({ id: userId, name, kind: "private" });
  });
  app.post("/api/login", authLimit, (req, res) => {
    const body = Login.parse(req.body),
      user = store.one<User>(
        "SELECT * FROM users WHERE name=? AND kind='private'",
        body.name.toLowerCase(),
      );
    const [salt, stored] = (user?.password ?? `none:${"0".repeat(128)}`).split(
      ":",
    );
    if (
      !timingSafeEqual(
        scryptSync(body.password, salt, 64),
        Buffer.from(stored, "hex"),
      ) ||
      !user
    )
      throw new HttpError(
        401,
        "The shelf name or password does not match. Please try again.",
      );
    const old = tokenFrom(req);
    if (old) store.run("DELETE FROM sessions WHERE tokenHash=?", hash(old));
    establish(res, user.id);
    res.json({ id: user.id, name: user.name, kind: user.kind });
  });
  app.post("/api/logout", (req, res) => {
    const token = tokenFrom(req);
    if (token) store.run("DELETE FROM sessions WHERE tokenHash=?", hash(token));
    res.clearCookie("evermore", { path: "/" });
    res.json({ ok: true });
  });
  const example = () => ({
    readOnly: true,
    book: sampleBook(),
    artwork: Array.from({ length: 12 }, (_, i) => `/api/example/art/${i}`),
  });
  app.get("/api/example", (_req, res) => res.json(example()));
  app.get("/api/example/art/:index", (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index > 11)
      throw new HttpError(404, "That example picture is unavailable.");
    res
      .type("image/svg+xml")
      .set("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(artSvg(index));
  });
  app.post("/api/demo", (req, res) => {
    const user = findUser(req);
    if (!user) return res.json(example());
    const projectId = id();
    store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      projectId,
      user.id,
      "The little things we learn",
      "synthetic_fixture",
      "needs_confirmation",
      0,
      JSON.stringify(sampleSource),
      now(),
      now(),
    );
    res.status(201).json({ id: projectId });
  });
  installLabRoutes(app, store, config, auth, owner);
  installAlmanacRoutes(app, store, { auth, owner, config });
  installOperatorCostRoutes(app, store, operatorGuard);
  installCommerceRoutes(app, store, auth, owner);
  installCommerceOperatorRoutes(app, store, operatorGuard);
  app.get("/api/operator/access", operatorGuard, (_req, res) =>
    res.json(accessView(store, config)),
  );
  app.post("/api/operator/invitations", operatorGuard, (req, res) =>
    res
      .status(201)
      .json(issueInvitation(store, owner(req).id, req.body, config)),
  );
  app.post(
    "/api/operator/invitations/:invitationId/revoke",
    operatorGuard,
    (req, res) => {
      revokeInvitation(store, owner(req).id, String(req.params.invitationId));
      res.json({ ok: true });
    },
  );
  app.get("/api/projects", auth, (req, res) =>
    res.json(
      store.all(
        "SELECT id,title,mode,status,revision,createdAt FROM projects WHERE ownerId=? AND NOT EXISTS(SELECT 1 FROM lab_runs WHERE lab_runs.projectId=projects.id) ORDER BY createdAt DESC",
        owner(req).id,
      ),
    ),
  );
  app.post("/api/projects", auth, (req, res) => {
    const body = z
      .object({
        consent: z.literal(true),
        title: z.string().trim().min(1).max(100),
      })
      .parse(req.body);
    if (owner(req).kind !== "private")
      throw new HttpError(
        403,
        "Create a private shelf before saving a real recording.",
      );
    const projectId = id();
    store.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
      projectId,
      owner(req).id,
      body.title,
      "unavailable",
      "draft",
      0,
      null,
      now(),
      now(),
    );
    res.status(201).json({ id: projectId });
  });
  app.get("/api/projects/:id", auth, (req, res) => {
    const p = project(req);
    const book = p.revision ? currentBook(p) : null;
    const isOperator = operatorId(store) === owner(req).id;
    const engine = studioView(store, p.id) ?? engineView(store, p.id);
    const familyFailure = "Your memory and completed work are saved. Please ask your Everlore host to help continue this story. You do not need to change any settings.";
    const visibleEngine = engine && !isOperator
      ? { ...engine, error: engine.error ? familyFailure : null, ...("recovery" in engine ? { recovery: null } : {}) }
      : engine;
    const jobs = store.all<{ id: string; status: string; stage: string; error: string | null; attempt: number }>(
      "SELECT id,status,stage,error,attempt FROM jobs WHERE projectId=? ORDER BY rowid DESC",
      p.id,
    );
    res.json({
      id: p.id,
      title: p.title,
      mode: p.mode,
      status: p.status,
      revision: p.revision,
      createdAt: p.createdAt,
      book,
      engine: visibleEngine,
      transcript: p.transcript ? JSON.parse(p.transcript) : null,
      recording:
        store.one(
          "SELECT id,mime,bytes,assetHash AS sha256,captureMode,createdAt FROM recordings WHERE projectId=?",
          p.id,
        ) ?? null,
      jobs: isOperator ? jobs : jobs.map(job => ({ ...job, error: job.error ? familyFailure : null })),
      editions: store.all(
        "SELECT id,revision,contentHash,pdfHash,createdAt FROM editions WHERE projectId=? ORDER BY revision DESC",
        p.id,
      ),
      corrections: store.all(
        "SELECT id,detail,kind,status FROM corrections WHERE projectId=?",
        p.id,
      ),
    });
  });
  app.post(
    "/api/projects/:id/recording",
    auth,
    express.raw({ type: "*/*", limit: "25mb" }),
    (req, res) => {
      const p = project(req);
      if (p.mode === "synthetic_fixture" || owner(req).kind !== "private")
        throw new HttpError(403, "A sample cannot hold a real recording.");
      const mime = String(req.headers["content-type"] ?? "").split(";")[0],
        bytes = req.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length < 44)
        throw new HttpError(
          400,
          "The recording is empty or incomplete. Please record again or choose an audio file.",
        );
      const accepted = [
        "audio/webm",
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "audio/mpeg",
        "audio/mp4",
        "audio/x-m4a",
        "video/mp4",
      ];
      if (!accepted.includes(mime))
        throw new HttpError(
          415,
          "Choose a WAV, MP3, M4A, OGG, or WebM recording.",
        );
      const matches =
        (mime.includes("wav") &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WAVE") ||
        (mime === "audio/webm" &&
          bytes.subarray(0, 4).toString("hex") === "1a45dfa3") ||
        (mime === "audio/ogg" && bytes.subarray(0, 4).toString() === "OggS") ||
        (mime === "audio/mpeg" &&
          (bytes.subarray(0, 3).toString() === "ID3" ||
            (bytes[0] === 255 && (bytes[1] & 224) === 224))) ||
        (["audio/mp4", "audio/x-m4a", "video/mp4"].includes(mime) &&
          bytes.subarray(4, 8).toString() === "ftyp");
      if (!matches)
        throw new HttpError(
          415,
          "That file does not look like the selected audio format. Please choose a different recording.",
        );
      const mode = z
        .enum(["microphone", "upload"])
        .parse(req.headers["x-capture-mode"] ?? "upload");
      const existing = store.one<{ id: string; assetHash: string }>(
        "SELECT id,assetHash FROM recordings WHERE projectId=?",
        p.id,
      );
      if (existing) {
        if (existing.assetHash !== hash(bytes))
          throw new HttpError(
            409,
            "This memory already has a recording. Start a new memory to keep another one.",
          );
        return res.json({
          id: existing.id,
          sha256: existing.assetHash,
          status: "stored",
        });
      }
      const recId = id();
      const digest = store.putAsset(p.id, bytes, "audio");
      store.transaction(() => {
        store.run(
          "INSERT INTO recordings VALUES(?,?,?,?,?,?,?)",
          recId,
          p.id,
          digest,
          mime,
          bytes.length,
          mode,
          now(),
        );
        store.run(
          "UPDATE projects SET status='awaiting_transcription' WHERE id=?",
          p.id,
        );
      });
      res.status(201).json({
        id: recId,
        sha256: digest,
        bytes: bytes.length,
        status: "stored",
      });
    },
  );
  app.get("/api/projects/:id/audio", auth, (req, res) => {
    const p = project(req),
      rec = requireValue(
        store.one<{ assetHash: string; mime: string }>(
          "SELECT assetHash,mime FROM recordings WHERE projectId=?",
          p.id,
        ),
      );
    const bytes = store.readAsset(p.id, rec.assetHash);
    res.setHeader("Content-Type", rec.mime);
    res.setHeader("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return res.status(416).end();
      const start = Number(match[1]),
        end = match[2]
          ? Math.min(Number(match[2]), bytes.length - 1)
          : bytes.length - 1;
      if (start > end || start >= bytes.length)
        return res
          .status(416)
          .set("Content-Range", `bytes */${bytes.length}`)
          .end();
      return res
        .status(206)
        .set("Content-Range", `bytes ${start}-${end}/${bytes.length}`)
        .send(bytes.subarray(start, end + 1));
    }
    res.send(bytes);
  });
  app.post("/api/projects/:id/transcript", auth, (req, res) => {
    const p = project(req),
      body = ManualTranscript.parse(req.body);
    if (
      p.mode === "synthetic_fixture" ||
      p.transcript ||
      engineView(store, p.id)
    )
      throw new HttpError(
        409,
        "The original transcript is already stored and cannot be replaced.",
      );
    const recording = requireValue(
      store.one<{ id: string }>(
        "SELECT id FROM recordings WHERE projectId=?",
        p.id,
      ),
      "Save a recording first.",
    );
    const segments = body.rawText
      .split(/\n+|(?<=[.!?])\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((text, i) => ({
        id: `s${i + 1}`,
        text,
        startMs: null,
        endMs: null,
      }));
    const transcript = Transcript.parse({
      version: 1,
      mode: "manual",
      recordingId: recording.id,
      rawText: body.rawText,
      segments,
    });
    store.run(
      "UPDATE projects SET transcript=?,status='needs_confirmation',mode='manual' WHERE id=?",
      JSON.stringify(transcript),
      p.id,
    );
    res.json(transcript);
  });
  app.post("/api/projects/:id/confirm", auth, (req, res) => {
    const p = project(req);
    z.object({ confirmed: z.literal(true) }).parse(req.body);
    if (engineView(store, p.id))
      throw new HttpError(409, "Use the story studio to confirm this memory.");
    if (p.mode !== "synthetic_fixture") {
      if (!p.transcript)
        throw new HttpError(409, "A transcript is needed first.");
      store.run(
        "UPDATE projects SET status='awaiting_editorial' WHERE id=?",
        p.id,
      );
      return res.json({ status: "awaiting_editorial" });
    }
    if (p.revision)
      throw new HttpError(
        409,
        "This example already has a book. Open its preview.",
      );
    res.json({ jobId: queueSample(store, p) });
  });
  app.post("/api/projects/:id/retry", auth, (req, res) => {
    const p = project(req),
      job = requireValue(
        store.one<{ id: string; attempt: number }>(
          "SELECT id,attempt FROM jobs WHERE projectId=? AND status='retryable_failure' AND baseRevision=?",
          p.id,
          p.revision,
        ),
      );
    if (job.attempt >= 3)
      throw new HttpError(
        409,
        "Three attempts have stopped. Your work is safe; a developer needs to inspect this job.",
      );
    store.run("UPDATE jobs SET status='queued',error=NULL WHERE id=?", job.id);
    store.run("UPDATE projects SET status='composing' WHERE id=?", p.id);
    res.json({ ok: true });
  });
  app.get("/api/projects/:id/art/:digest", auth, (req, res) => {
    const p = project(req);
    const digest = String(req.params.digest);
    requireValue(
      store.one(
        "SELECT hash FROM assets WHERE projectId=? AND hash=? AND kind='art'",
        p.id,
        digest,
      ),
    );
    const bytes = store.readAsset(p.id, digest);
    res
      .type(
        bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
          ? "image/png"
          : "image/svg+xml",
      )
      .set("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(bytes);
  });
  app.post("/api/projects/:id/engine", auth, (req, res) => {
    const p = project(req);
    if (owner(req).kind !== "private")
      throw new HttpError(403, "Open your private shelf first.");
    res.json({
      id:
        latestStudio(store, p.id) || !engineView(store, p.id)
          ? queueStudio(store, p, req.body, config)
          : queueEngine(store, p, req.body, config),
    });
  });
  app.post("/api/projects/:id/engine/source", auth, (req, res) => {
    const p = project(req);
    if (latestStudio(store, p.id)) confirmStudioSource(store, p.id, req.body);
    else confirmEngineSource(store, p.id, req.body);
    res.json({ ok: true });
  });
  app.post("/api/projects/:id/engine/art", auth, (req, res) => {
    const p = project(req);
    if (latestStudio(store, p.id)) approveStudioArt(store, p.id, req.body);
    else approveEngineArt(store, p.id, req.body);
    res.json({ ok: true });
  });
  app.get("/api/projects/:id/archive", auth, (req, res) => {
    const p = project(req);
    res
      .type("application/gzip")
      .set(
        "Content-Disposition",
        "attachment; filename=Everlore-family-archive.everlore",
      )
      .send(exportArchive(store, p));
  });
  app.post(
    "/api/archives/restore",
    auth,
    express.raw({ type: "application/octet-stream", limit: "128mb" }),
    (req, res) => {
      if (owner(req).kind !== "private")
        throw new HttpError(403, "Open your private shelf first.");
      try {
        res.status(201).json(restoreArchive(store, owner(req).id, req.body));
      } catch {
        throw new HttpError(
          400,
          "This archive could not be verified. No active story was replaced.",
        );
      }
    },
  );
  app.get("/api/studio-setup", auth, (req, res) =>
    res.json(familySetupView(store, owner(req).id, config)),
  );
  app.post("/api/studio-setup", auth, async (req, res) => {
    if (owner(req).kind !== "private")
      throw new HttpError(403, "Open your private shelf first.");
    res.json(
      await saveVerifiedStudioConnection(
        store,
        owner(req).id,
        req.body,
        config,
        connectionRequest,
      ),
    );
  });
  app.post("/api/studio-setup/check", auth, async (req, res) => {
    if (owner(req).kind !== "private")
      throw new HttpError(403, "Open your private shelf first.");
    res.json(
      await checkSavedStudioConnection(
        store,
        owner(req).id,
        config,
        connectionRequest,
      ),
    );
  });
  app.post("/api/projects/:id/engine/resume", auth, async (req, res) => {
    const p = project(req);
    requireOperator(store, owner(req).id);
    if (owner(req).kind !== "private")
      throw new HttpError(403, "Open your private shelf first.");
    if (!hostingOrigin || operatorId(store) === owner(req).id)
      await checkSavedStudioConnection(
        store,
        owner(req).id,
        config,
        connectionRequest,
      );
    res.json(resumeStudio(store, p, req.body, config));
  });
  app.get("/api/operator/studio-setup", operatorGuard, (req, res) => res.json(setupView(store, owner(req).id, config)));
  app.post("/api/operator/studio-setup", operatorGuard, async (req, res) => {
    res.json(await saveVerifiedStudioConnection(store, owner(req).id, req.body, config, connectionRequest));
  });
  app.post("/api/operator/studio-setup/check", operatorGuard, async (req, res) => {
    res.json(await checkSavedStudioConnection(store, owner(req).id, config, connectionRequest));
  });
  app.get("/api/operator/projects/:id/recovery", operatorGuard, (req, res) => {
    const p = requireValue(store.one<ProjectRow>("SELECT * FROM projects WHERE id=?", String(req.params.id)));
    const job = latestStudio(store, p.id);
    if (job?.kind === "interview_transcription") {
      const source = requireValue(store.one<{sessionId:string;turnId:string}>("SELECT sessionId,turnId FROM almanac_transcriptions WHERE jobId=?", job.id), "This interview recovery record is unavailable.");
      return res.json({ kind: "interview", interview: interviewRecovery(store, owner(req).id, source.sessionId, source.turnId) });
    }
    res.json({ kind: "story", jobId: job?.id ?? null, recovery: job ? studioRecovery(store, job.id) : null, error: job?.error ?? null });
  });
  app.post("/api/operator/projects/:id/resume", operatorGuard, async (req, res) => {
    const p = requireValue(store.one<ProjectRow>("SELECT * FROM projects WHERE id=?", String(req.params.id)));
    if (store.one("SELECT jobId FROM almanac_transcriptions t JOIN studio_jobs j ON j.id=t.jobId WHERE j.projectId=?", p.id))
      throw new HttpError(409, "Use this interview’s dedicated recovery controls. An uncertain transcription cannot be retried through story recovery.");
    await checkSavedStudioConnection(store, owner(req).id, config, connectionRequest);
    res.json(resumeStudio(store, p, req.body, config));
  });
  app.get("/api/families", auth, (req, res) =>
    res.json(familyVersions(store, owner(req).id)),
  );
  app.post("/api/projects/:id/engine/heart", auth, (req, res) => {
    confirmStudioHeart(store, project(req).id, req.body);
    res.json({ ok: true });
  });
  app.post("/api/projects/:id/engine/cast", auth, (req, res) => {
    approveStudioCast(store, project(req).id, req.body);
    res.json({ ok: true });
  });
  app.post("/api/projects/:id/engine/direction", auth, (req, res) =>
    res.json({ id: changeDirection(store, project(req), req.body, config) }),
  );
  app.post("/api/projects/:id/engine/repair", auth, (req, res) =>
    res.json({ id: queueRepair(store, project(req), req.body, config) }),
  );
  app.get("/api/projects/:id/engine/evidence", operatorGuard, (req, res) => {
    const p = requireValue(store.one<ProjectRow>("SELECT * FROM projects WHERE id=?", String(req.params.id)));
    const jobs = store.all<{
      id: string;
      status: string;
      stage: string;
      kind: string;
      createdAt: string;
    }>(
      "SELECT id,status,stage,kind,createdAt FROM studio_jobs WHERE projectId=? ORDER BY rowid",
      p.id,
    );
    res.json({
      warning:
        "Machine assessments are provisional, not child-response evidence. Costs are reservations unless reported as actual.",
      jobs: jobs.map((j) => ({
        ...j,
        steps: store.all(
          "SELECT stage,inputHash,state,result FROM studio_steps WHERE jobId=?",
          j.id,
        ),
        calls: store.all(
          "SELECT stage,kind,model,status,latencyMs,requestId,usage,estimatedCents,actualCents FROM studio_calls WHERE jobId=?",
          j.id,
        ),
        approvals: store.all(
          "SELECT gate,inputHash,createdAt FROM studio_approvals WHERE jobId=?",
          j.id,
        ),
      })),
    });
  });
  app.post("/api/projects/:id/rename", auth, async (req, res) => {
    const p = project(req),
      body = RevisionRequest.parse(req.body),
      requestHash = hash(canonical(body));
    const prior = store.one<{ requestHash: string; resultRevision: number }>(
      "SELECT requestHash,resultRevision FROM edits WHERE projectId=? AND key=?",
      p.id,
      body.key,
    );
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new HttpError(409, "That change key was already used.");
      return res.json({ revision: prior.resultRevision });
    }
    if (p.revision !== body.baseRevision)
      throw new HttpError(
        409,
        "This book has changed. Reopen it before making your correction.",
      );
    const book = currentBook(p);
    if (
      book.people.some(
        (person) =>
          person.id !== body.personId &&
          person.name.toLowerCase() === body.newName.toLowerCase(),
      )
    )
      throw new HttpError(
        400,
        "Two people would have the same name. Keep their names distinct for this example.",
      );
    if (book.production)
      throw new HttpError(
        409,
        "Use a new memory with the corrected family name. This studio edition keeps its approved family identity.",
      );
    const next = await renamePerson(book, body.personId, body.newName);
    store.transaction(() => {
      const latest = requireValue(
        store.one<ProjectRow>("SELECT * FROM projects WHERE id=?", p.id),
      );
      if (latest.revision !== body.baseRevision)
        throw new HttpError(
          409,
          "This book has changed. Reopen it before making your correction.",
        );
      store.run(
        "INSERT INTO revisions VALUES(?,?,?,?)",
        p.id,
        next.revision,
        JSON.stringify(next),
        next.contentHash,
      );
      store.run(
        "UPDATE projects SET revision=?,title=?,status='ready_for_review' WHERE id=?",
        next.revision,
        next.title,
        p.id,
      );
      store.run(
        "INSERT INTO edits VALUES(?,?,?,?)",
        p.id,
        body.key,
        requestHash,
        next.revision,
      );
    });
    res.json({
      revision: next.revision,
      affectedSpreads: next.spreads
        .filter(
          (s, i) =>
            s.text !== book.spreads[i].text ||
            s.artDescription !== book.spreads[i].artDescription,
        )
        .map((s) => s.id),
      imagesReused: 12,
    });
  });
  app.post("/api/projects/:id/corrections", auth, (req, res) => {
    const p = project(req),
      body = Correction.parse(req.body);
    if (p.revision !== body.baseRevision)
      throw new HttpError(409, "This book has changed. Please reopen it.");
    if (
      body.spreadId &&
      !currentBook(p).spreads.some((s) => s.id === body.spreadId)
    )
      throw new HttpError(400, "Choose an existing spread.");
    const correctionId = id();
    store.run(
      "INSERT INTO corrections VALUES(?,?,?,?,?,?,?)",
      correctionId,
      p.id,
      p.revision,
      body.kind,
      body.detail,
      body.spreadId,
      "pending_editorial",
    );
    res.status(201).json({ id: correctionId, status: "pending_editorial" });
  });
  app.post("/api/projects/:id/editions", auth, async (req, res) => {
    const p = project(req),
      body = Approval.parse(req.body),
      book = currentBook(p);
    if (
      book.revision !== body.baseRevision ||
      book.contentHash !== body.contentHash
    )
      throw new HttpError(
        409,
        "This book has changed. Please review its current version.",
      );
    if (
      store.one(
        "SELECT id FROM corrections WHERE projectId=? AND status='pending_editorial'",
        p.id,
      )
    )
      throw new HttpError(
        409,
        "A requested correction is still pending. Keep reviewing until it has been resolved.",
      );
    const activeStudio = latestStudio(store, p.id);
    if (
      activeStudio &&
      !["complete", "superseded"].includes(activeStudio.status)
    )
      throw new HttpError(
        409,
        "A studio revision is still in progress. Review it before saving an edition.",
      );
    const existing = store.one(
      "SELECT id,revision,contentHash,pdfHash,createdAt FROM editions WHERE projectId=? AND revision=?",
      p.id,
      p.revision,
    );
    if (existing) return res.json(existing);
    const bytes = await renderPdf(book, store, p.id);
    const editionId = id(),
      createdAt = now();
    const result = store.transaction(() => {
      const latest = requireValue(
        store.one<ProjectRow>("SELECT * FROM projects WHERE id=?", p.id),
      );
      if (latest.revision !== book.revision)
        throw new HttpError(
          409,
          "The book changed while its export was prepared. Please review it again.",
        );
      if (
        store.one(
          "SELECT id FROM corrections WHERE projectId=? AND status='pending_editorial'",
          p.id,
        )
      )
        throw new HttpError(
          409,
          "A correction was requested while the export was prepared.",
        );
      const duplicate = store.one(
        "SELECT id,revision,contentHash,pdfHash,createdAt FROM editions WHERE projectId=? AND revision=?",
        p.id,
        p.revision,
      );
      if (duplicate) return duplicate;
      const pdfHash = store.putAsset(p.id, bytes, "pdf");
      store.run(
        "INSERT INTO editions VALUES(?,?,?,?,?,?,?)",
        editionId,
        p.id,
        book.revision,
        book.contentHash,
        pdfHash,
        JSON.stringify(book),
        createdAt,
      );
      store.run("UPDATE projects SET status='edition_saved' WHERE id=?", p.id);
      return {
        id: editionId,
        revision: book.revision,
        contentHash: book.contentHash,
        pdfHash,
        createdAt,
      };
    });
    res.status(201).json(result);
  });
  app.get("/api/projects/:id/editions/:editionId", auth, (req, res) => {
    const p = project(req);
    const edition = requireValue(
      store.one<{
        book: string;
        contentHash: string;
        pdfHash: string;
        revision: number;
      }>(
        "SELECT book,contentHash,pdfHash,revision FROM editions WHERE id=? AND projectId=?",
        String(req.params.editionId),
        p.id,
      ),
    );
    res.json({ ...edition, book: JSON.parse(edition.book) });
  });
  app.get("/api/projects/:id/editions/:editionId/pdf", auth, (req, res) => {
    const p = project(req),
      edition = requireValue(
        store.one<{ pdfHash: string; revision: number }>(
          "SELECT pdfHash,revision FROM editions WHERE id=? AND projectId=?",
          String(req.params.editionId),
          p.id,
        ),
      );
    res
      .type("application/pdf")
      .set(
        "Content-Disposition",
        `attachment; filename="Everlore-review-edition-${edition.revision}.pdf"`,
      )
      .send(store.readAsset(p.id, edition.pdfHash));
  });
  app.delete("/api/projects/:id", auth, (req, res) => {
    const p = project(req);
    if (store.one("SELECT id FROM lab_runs WHERE projectId=?", p.id))
      throw new EngineError(
        "Lab artifacts are retained as experiment evidence.",
      );
    if (store.one("SELECT id FROM book_orders WHERE projectId=?", p.id))
      throw new EngineError(
        "This book has a retained purchase record. Contact support before deleting its print assets.",
      );
    store.deleteProject(p.id);
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "That page is not available." }),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof AccessError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof EngineError)
        return res.status(409).json({ error: error.message });
      if (error instanceof ZodError)
        return res.status(400).json({
          error: "Please check the information and try again.",
          fields: error.issues.map((x) => x.path.join(".")),
        });
      if (
        error &&
        typeof error === "object" &&
        "type" in error &&
        error.type === "entity.too.large"
      )
        return res.status(413).json({
          error:
            "That recording is too large. Choose a file smaller than 25 MB.",
        });
      if (error instanceof SyntaxError)
        return res
          .status(400)
          .json({ error: "That request could not be read. Please try again." });
      // Never log source text, credentials, cookies, or private provider payloads.
      console.error(
        "request_failed",
        error instanceof Error ? error.name : "unknown",
      );
      res.status(500).json({
        error:
          "Something stopped before this step finished. Your previously saved work is safe. Please try again.",
      });
    },
  );
  return app;
}
