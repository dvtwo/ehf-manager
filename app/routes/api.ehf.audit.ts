import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { saveEhfApplication, type ApplyLineItemInput } from "../ehf.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// POST /api/ehf/audit — stores audit log written by the extension after a successful order edit.
// No Shopify auth needed: the extension already committed the order edit via its own token;
// this endpoint only writes to our internal Postgres audit tables.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, { status: 405, headers: CORS });
  }

  let body: {
    shop?: string;
    orderId?: string;
    orderName?: string;
    provinceCode?: string;
    totalAmountCents?: number;
    lineBreakdown?: ApplyLineItemInput[];
    shopifyLineItemId?: string;
  };

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, { status: 400, headers: CORS });
  }

  const { shop, orderId, orderName, provinceCode, totalAmountCents, lineBreakdown } = body;

  if (!shop || !orderId || !provinceCode || totalAmountCents === undefined) {
    return json(
      { error: "shop, orderId, provinceCode, and totalAmountCents are required." },
      { status: 400, headers: CORS }
    );
  }

  await saveEhfApplication({
    orderId,
    orderName: orderName ?? "",
    shopDomain: shop,
    provinceCode,
    totalAmountCents,
    lineBreakdown: lineBreakdown ?? [],
    shopifyLineItemId: body.shopifyLineItemId ?? null,
    appliedBy: null,
  });

  return json({ success: true }, { headers: CORS });
}
