import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calculateOrderEhf, type LineItemInput } from "../ehf.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const GET_ORDER_QUERY = `#graphql
  query GetOrderForEhf($id: ID!) {
    order(id: $id) {
      id
      name
      shippingAddress {
        provinceCode
        province
        countryCode
      }
      lineItems(first: 100) {
        edges {
          node {
            id
            title
            quantity
            variant {
              id
              sku
            }
          }
        }
      }
    }
  }
`;

export async function loader({ request, params }: LoaderFunctionArgs) {
  // CORS preflight handled via action below; preflight for GET goes to action.
  const { admin, session } = await authenticate.admin(request);

  // orderId arrives URL-encoded from the extension: encodeURIComponent(gid://...)
  const orderId = decodeURIComponent(params.orderId ?? "");
  if (!orderId) {
    return json(
      { error: "Order ID is required." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Fetch order from Shopify Admin API
  const response = await admin.graphql(GET_ORDER_QUERY, {
    variables: { id: orderId },
  });
  const { data, errors } = await response.json();

  if (errors?.length || !data?.order) {
    return json(
      { error: "Order not found." },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const order = data.order;
  const provinceCode: string =
    order.shippingAddress?.provinceCode?.toUpperCase() ?? "";
  const provinceName: string = order.shippingAddress?.province ?? provinceCode;

  const lineItemInputs: LineItemInput[] = order.lineItems.edges
    .map((e: { node: { id: string; title: string; quantity: number; variant?: { sku?: string } } }) => ({
      lineItemId: e.node.id,
      title: e.node.title,
      sku: e.node.variant?.sku ?? null,
      quantity: e.node.quantity,
    }))
    // Skip the existing EHF line item so it doesn't show in the list
    .filter((item: LineItemInput) => item.title !== "Environmental Handling Fee");

  const calculatedItems = await calculateOrderEhf(lineItemInputs, provinceCode);

  // Check for an existing EHF application in our DB
  const existing = await prisma.ehfApplication.findUnique({
    where: { orderId },
    select: {
      totalAmountCents: true,
      appliedBy: true,
      appliedAt: true,
      lineBreakdown: true,
    },
  });

  // Merge existing override decisions into the suggested calculations
  if (existing?.lineBreakdown) {
    const prevBreakdown = existing.lineBreakdown as {
      lineItemId: string;
      chargeEhf: boolean;
      appliedAmountCents: number;
      isOverride: boolean;
      overrideReason: string;
    }[];
    const prevMap = new Map(prevBreakdown.map((p) => [p.lineItemId, p]));

    for (const item of calculatedItems) {
      const prev = prevMap.get(item.lineItemId);
      if (prev) {
        item.chargeEhf = prev.chargeEhf;
        item.appliedAmountCents = prev.isOverride
          ? prev.appliedAmountCents
          : item.suggestedAmountCents;
        item.isOverride = prev.isOverride;
        item.overrideReason = prev.overrideReason;
      }
    }
  }

  return json(
    {
      orderId,
      orderName: order.name,
      provinceCode,
      province: provinceName,
      lineItems: calculatedItems,
      existingApplication: existing
        ? {
            totalAmountCents: existing.totalAmountCents,
            appliedBy: existing.appliedBy,
            appliedAt: (existing.appliedAt as Date).toISOString(),
          }
        : null,
    },
    { headers: CORS_HEADERS }
  );
}

// Handle CORS preflight (OPTIONS falls to action in Remix)
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json({ error: "Method not allowed." }, { status: 405, headers: CORS_HEADERS });
}
