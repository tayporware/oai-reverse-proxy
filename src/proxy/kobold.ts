/* Pretends to be a KoboldAI API endpoint and translates incoming Kobold
requests to OpenAI API equivalents. */

import { Request, Response, Router } from "express";
import http from "http";
import { createProxyMiddleware } from "http-proxy-middleware";
import util from "util";
import zlib from "zlib";
import { logger } from "../logger";
import {
  copyHttpHeaders,
  handleDownstreamErrors,
  handleInternalError,
  incrementKeyUsage,
} from "./common";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  disableStream,
  finalizeBody,
  languageFilter,
  limitOutputTokens,
  transformKoboldPayload,
} from "./rewriters";

export const handleModelRequest = (_req: Request, res: Response) => {
  res.status(200).json({ result: "Connected to OpenAI reverse proxy" });
};

export const handleSoftPromptsRequest = (_req: Request, res: Response) => {
  res.status(200).json({ soft_prompts_list: [] });
};

const rewriteRequest = (
  proxyReq: http.ClientRequest,
  req: Request,
  res: Response
) => {
  const rewriterPipeline = [
    addKey,
    transformKoboldPayload,
    languageFilter,
    disableStream,
    limitOutputTokens,
    finalizeBody,
  ];

  try {
    for (const rewriter of rewriterPipeline) {
      rewriter(proxyReq, req, res, {});
    }
  } catch (error) {
    logger.error(error, "Error while executing proxy rewriter");
    proxyReq.destroy(error as Error);
  }
};

const handleProxiedResponse = async (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => {
  try {
    await handleDownstreamErrors(proxyRes, req, res);
  } catch (error) {
    // Handler takes over the response, we're done here.
    return;
  }
  incrementKeyUsage(req);
  copyHttpHeaders(proxyRes, res);

  // For Kobold we need to consume the response body to turn it into a KoboldAI
  // response payload.
  let chunks: Buffer[] = [];
  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", async () => {
    let body = Buffer.concat(chunks);
    const contentEncoding = proxyRes.headers["content-encoding"];

    if (contentEncoding === "gzip") {
      body = await util.promisify(zlib.gunzip)(body);
    } else if (contentEncoding === "deflate") {
      body = await util.promisify(zlib.inflate)(body);
    }

    const response = JSON.parse(body.toString());

    const koboldResponse = {
      results: [{ text: response.choices[0].message.content }],
      model: response.model,
    };

    // Because we have decompressed the OpenAI response, we need to re-compress it
    // before sending it to the client.
    if (contentEncoding === "gzip") {
      res.set("Content-Encoding", "gzip");
      res.send(await util.promisify(zlib.gzip)(JSON.stringify(koboldResponse)));
    } else if (contentEncoding === "deflate") {
      res.set("Content-Encoding", "deflate");
      res.send(
        await util.promisify(zlib.deflate)(JSON.stringify(koboldResponse))
      );
    } else {
      res.send(JSON.stringify(koboldResponse));
    }
  });
};

const koboldOaiProxy = createProxyMiddleware({
  target: "https://api.openai.com",
  changeOrigin: true,
  pathRewrite: {
    "^/api/v1/generate": "/v1/chat/completions",
  },
  on: {
    proxyReq: rewriteRequest,
    proxyRes: handleProxiedResponse,
    error: handleInternalError,
  },
  selfHandleResponse: true,
  logger,
});

const koboldRouter = Router();
koboldRouter.get("/api/v1/model", handleModelRequest);
koboldRouter.get("/api/v1/config/soft_prompts_list", handleSoftPromptsRequest);
koboldRouter.post("/api/v1/generate", ipLimiter, koboldOaiProxy);
koboldRouter.use((req, res) => {
  logger.warn(`Unhandled kobold request: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

export const kobold = koboldRouter;
