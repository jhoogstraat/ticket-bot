import { createHmac, timingSafeEqual } from "node:crypto";
import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
import { createGitLabWebhookIngressService } from "../restate/webhooks/gitlab-webhook.js";
import { createJenkinsWebhookIngressService } from "../restate/webhooks/jenkins-webhook.js";
import { createJiraWebhookIngressService } from "../restate/webhooks/jira-webhook.js";
import { createSonarQubeWebhookIngressService } from "../restate/webhooks/sonarqube-webhook.js";

type WebhookRestateServices = {
  jira: ReturnType<typeof createJiraWebhookIngressService>;
  jenkins: ReturnType<typeof createJenkinsWebhookIngressService>;
  sonarqube: ReturnType<typeof createSonarQubeWebhookIngressService>;
  gitlab: ReturnType<typeof createGitLabWebhookIngressService>;
};

export interface WebhookApiOptions {
  port: number;
  restateIngressUrl: string;
  signingSecret?: string;
  services: WebhookRestateServices;
}

/**
 * Public HTTP boundary for provider callbacks. It authenticates raw payloads
 * before forwarding a normalized event to a durable Restate webhook handler.
 */
export function startWebhookApi(options: WebhookApiOptions) {
  const ingress = clients.connect({ url: options.restateIngressUrl });
  return Bun.serve({
    port: options.port,
    fetch: async (request) => {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const route = new URL(request.url).pathname;
      const rawBody = await request.text();
      if (!hasValidSignature(request, rawBody, options.signingSecret))
        return new Response("Invalid webhook signature", { status: 401 });

      let event: unknown;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return new Response("Webhook body must be JSON", { status: 400 });
      }

      const providerEventId = extractProviderEventId(event);
      if (!providerEventId)
        return new Response("Webhook event requires providerEventId", { status: 400 });
      try {
        const result = await dispatch(route, event, providerEventId, ingress, options.services);
        return Response.json(result, { status: 202 });
      } catch (error) {
        console.error("webhook.forward_failed", { route, providerEventId, error });
        return new Response("Webhook could not be accepted", { status: 502 });
      }
    },
  });
}

async function dispatch(
  route: string,
  event: unknown,
  providerEventId: string,
  ingress: clients.Ingress,
  services: WebhookRestateServices,
): Promise<unknown> {
  switch (route) {
    case "/webhooks/jira":
      return await ingress
        .serviceClient(services.jira)
        .receive(event, clients.rpc.opts({ idempotencyKey: providerEventId }));
    case "/webhooks/jenkins":
      return await ingress
        .serviceClient(services.jenkins)
        .receive(event, clients.rpc.opts({ idempotencyKey: providerEventId }));
    case "/webhooks/sonarqube":
      return await ingress
        .serviceClient(services.sonarqube)
        .receive(event, clients.rpc.opts({ idempotencyKey: providerEventId }));
    case "/webhooks/gitlab":
      return await ingress
        .serviceClient(services.gitlab)
        .receive(event, clients.rpc.opts({ idempotencyKey: providerEventId }));
    default:
      throw new Error(`Unsupported webhook route: ${route}`);
  }
}

const providerEventSchema = z.looseObject({ providerEventId: z.string().min(1) });

function extractProviderEventId(event: unknown): string | undefined {
  return providerEventSchema.safeParse(event).data?.providerEventId;
}

function hasValidSignature(request: Request, rawBody: string, secret: string | undefined): boolean {
  if (!secret) return true;
  const received = request.headers.get("x-ticket-bot-signature");
  if (!received) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}
