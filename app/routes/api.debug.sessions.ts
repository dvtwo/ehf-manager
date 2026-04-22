import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS = { "Access-Control-Allow-Origin": "*" };

// GET /api/debug/sessions?shop=true49.myshopify.com
// Returns session metadata (no tokens) to diagnose auth issues.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  if (!shop) return json({ error: "shop param required" }, { status: 400, headers: CORS });

  const sessions = await prisma.session.findMany({
    where: { shop },
    orderBy: { id: "desc" },
    select: {
      id: true,
      shop: true,
      isOnline: true,
      scope: true,
      expires: true,
      // accessToken deliberately omitted — just show first 8 chars to confirm it exists
      accessToken: true,
    },
  });

  return json(
    {
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id,
        isOnline: s.isOnline,
        scope: s.scope,
        expires: s.expires,
        hasToken: !!s.accessToken,
        tokenPreview: s.accessToken ? s.accessToken.slice(0, 8) + "…" : null,
      })),
    },
    { headers: CORS }
  );
}

// DELETE /api/debug/sessions?shop=true49.myshopify.com
// Flushes all sessions for a shop so the next app open triggers fresh OAuth.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405, headers: CORS });
  }
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  if (!shop) return json({ error: "shop param required" }, { status: 400, headers: CORS });

  const { count } = await prisma.session.deleteMany({ where: { shop } });
  return json({ deleted: count }, { headers: CORS });
}
