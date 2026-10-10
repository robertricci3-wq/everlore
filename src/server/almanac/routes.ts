import express, {
  type Express,
  type Request,
  type RequestHandler,
} from "express";
import { z } from "zod";
import type { Store } from "../store.js";
import type { EngineConfig } from "../engine/provider.js";
import {
  almanacView,
  pageView,
  addPage,
  editPage,
  associateMemory,
  startSession,
  sessionView,
  setSessionStatus,
  startTurn,
  saveTurnAudio,
  saveTurnText,
  skipTurn,
  freezeSource,
  ownedSession,
  readTurn,
  startTitleSession,
  applyPageTitle,
} from "./service.js";
import {
  queueInterviewTranscription,
  interviewRecovery,
  retryInterviewTranscription,
} from "./transcription.js";
import { AccessError } from "../access.js";

export function installAlmanacRoutes(
  app: Express,
  s: Store,
  options: {
    auth: RequestHandler;
    owner: (req: Request) => { id: string };
    config: EngineConfig;
  },
) {
  const { auth, owner, config } = options;
  const user = (req: Request) => owner(req).id;
  const param = (req: Request, name: string) => String(req.params[name]);
  app.get("/api/almanac", auth, (req, res) =>
    res.json(almanacView(s, user(req))),
  );
  app.post("/api/almanac/pages", auth, (req, res) =>
    res.status(201).json(addPage(s, user(req), req.body)),
  );
  app.get("/api/almanac/pages/:pageId", auth, (req, res) =>
    res.json(pageView(s, user(req), param(req, "pageId"))),
  );
  app.patch("/api/almanac/pages/:pageId", auth, (req, res) =>
    res.json(editPage(s, user(req), param(req, "pageId"), req.body)),
  );
  app.post("/api/almanac/pages/:pageId/memories", auth, (req, res) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        remove: z.boolean().default(false),
      })
      .parse(req.body);
    associateMemory(
      s,
      user(req),
      param(req, "pageId"),
      body.projectId,
      body.remove,
    );
    res.json(pageView(s, user(req), param(req, "pageId")));
  });
  app.post("/api/almanac/pages/:pageId/sessions", auth, (req, res) =>
    res
      .status(201)
      .json(startSession(s, user(req), param(req, "pageId"), req.body)),
  );
  app.post("/api/almanac/pages/:pageId/title-session", auth, (req, res) =>
    res
      .status(201)
      .json(startTitleSession(s, user(req), param(req, "pageId"), req.body)),
  );
  app.post("/api/interviews/:sessionId/apply-title", auth, (req, res) =>
    res.json(applyPageTitle(s, user(req), param(req, "sessionId"), req.body)),
  );
  app.get("/api/interviews/:sessionId", auth, (req, res) =>
    res.json(sessionView(s, user(req), param(req, "sessionId"))),
  );
  app.post("/api/interviews/:sessionId/finish", auth, (req, res) =>
    res.json(
      setSessionStatus(s, user(req), param(req, "sessionId"), "finished"),
    ),
  );
  app.post("/api/interviews/:sessionId/reopen", auth, (req, res) =>
    res.json(setSessionStatus(s, user(req), param(req, "sessionId"), "open")),
  );
  app.post("/api/interviews/:sessionId/turns", auth, (req, res) =>
    res
      .status(201)
      .json(startTurn(s, user(req), param(req, "sessionId"), req.body)),
  );
  app.put(
    "/api/interviews/:sessionId/turns/:turnId/audio",
    auth,
    express.raw({ type: "*/*", limit: "25mb" }),
    (req, res) =>
      res.json(
        saveTurnAudio(
          s,
          user(req),
          param(req, "sessionId"),
          param(req, "turnId"),
          req.body as Buffer,
          String(req.headers["content-type"] ?? "").split(";")[0],
          req.headers["x-capture-mode"],
        ),
      ),
  );
  app.get(
    "/api/interviews/:sessionId/turns/:turnId/audio",
    auth,
    (req, res) => {
      const session = ownedSession(s, user(req), param(req, "sessionId"));
      const turn = readTurn(s, session.id, param(req, "turnId"));
      if (!turn.audio)
        throw new AccessError(404, "This answer has no recording.");
      res
        .set("Cache-Control", "private, no-store")
        .type(turn.audio.mime)
        .send(s.readAsset(session.projectId, turn.audio.sha256));
    },
  );
  app.post("/api/interviews/:sessionId/turns/:turnId/text", auth, (req, res) =>
    res.json(
      saveTurnText(
        s,
        user(req),
        param(req, "sessionId"),
        param(req, "turnId"),
        req.body,
      ),
    ),
  );
  app.post("/api/interviews/:sessionId/turns/:turnId/skip", auth, (req, res) =>
    res.json(
      skipTurn(s, user(req), param(req, "sessionId"), param(req, "turnId")),
    ),
  );
  app.post(
    "/api/interviews/:sessionId/turns/:turnId/transcribe",
    auth,
    (req, res) =>
      res
        .status(202)
        .json(
          queueInterviewTranscription(
            s,
            user(req),
            param(req, "sessionId"),
            param(req, "turnId"),
            req.body,
            config,
          ),
        ),
  );
  app.post("/api/interviews/:sessionId/freeze", auth, (req, res) =>
    res.json(freezeSource(s, user(req), param(req, "sessionId"), req.body)),
  );
  app.get(
    "/api/operator/interviews/:sessionId/turns/:turnId/recovery",
    auth,
    (req, res) =>
      res.json(
        interviewRecovery(
          s,
          user(req),
          param(req, "sessionId"),
          param(req, "turnId"),
        ),
      ),
  );
  app.post(
    "/api/operator/interviews/:sessionId/turns/:turnId/recovery",
    auth,
    (req, res) =>
      res.json(
        retryInterviewTranscription(
          s,
          user(req),
          param(req, "sessionId"),
          param(req, "turnId"),
          req.body,
          config,
        ),
      ),
  );
}
