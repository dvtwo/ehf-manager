import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  saveEhfApplication,
  EHF_LINE_ITEM_TITLE,
  type ApplyLineItemInput,
} from "../ehf.server";

const SHOPIFY_API_VERSION = "2024-10";

function extractGqlErrors(errors: unknown): string | null {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.map((e: any) => e?.message ?? String(e)).join("; ");
  if (typeof errors === "string") return errors;
  if (typeof errors === "object") return (errors as any).message ?? JSON.stringify(errors);
  return String(errors);
}

async function shopifyGraphql(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
) {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return res.json();
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

// ── GraphQL mutations ─────────────────────────────────────────────────────────

const ORDER_EDIT_BEGIN = `#graphql
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        lineItems(first: 100) {
          edges {
            node { id title }
          }
        }
        shippingLines {
          id
          title
        }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_SET_QTY = `#graphql
  mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetLineItemQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_ADD_SHIPPING_LINE = `#graphql
  mutation OrderEditAddShippingLine($id: ID!, $shippingLine: OrderEditShippingLineInput!) {
    orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
      calculatedOrder { id }
      calculatedShippingLine { id }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_REMOVE_SHIPPING_LINE = `#graphql
  mutation OrderEditRemoveShippingLine($id: ID!, $shippingLineId: ID!) {
    orderEditRemoveShippingLine(id: $id, shippingLineId: $shippingLineId) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_COMMIT = `#graphql
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id name }
      userErrors { field message }
    }
  }
`;

// Store breakdown as a metafield on the order for Shopify-side visibility
const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message }
    }
  }
`;

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body: {
    shop: string;
    orderId: string;
    provinceCode?: string;
    lineItems: ApplyLineItemInput[];
  };

  try {
    body = await request.json();
  } catch {
    return json(
      { error: "Invalid JSON body." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { shop: rawShop, orderId, lineItems } = body;

  if (!rawShop || !orderId || !Array.isArray(lineItems)) {
    return json(
      { error: "shop, orderId, and lineItems are required." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Strip protocol if present, e.g. "https://store.myshopify.com" → "store.myshopify.com"
  const shop = rawShop.replace(/^https?:\/\//, "").replace(/\/$/, "");

  // Normalize to full GID — extension may return a numeric ID
  const orderGid = orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  // Prefer the most-recently-created online session (unstable_newEmbeddedAuthStrategy creates
  // these on reinstall), then fall back to offline sessions from traditional OAuth.
  const allSessions = await prisma.session.findMany({
    where: { shop },
    orderBy: { id: "desc" },
  });
  // Online sessions (isOnline=true) from recent installs take priority over revoked offline ones
  const session =
    allSessions.find((s) => s.isOnline && s.accessToken) ??
    allSessions.find((s) => s.accessToken) ??
    null;
  if (!session?.accessToken) {
    return json(
      { error: `No session found for ${shop}. Please open the EHF Manager app from your Shopify admin to authorize it.` },
      { status: 401, headers: CORS_HEADERS }
    );
  }
  const accessToken = session.accessToken;
  const staffUser = session.email ?? null;

  const chargedItems = lineItems.filter((i) => i.chargeEhf);
  const totalAmountCents = chargedItems.reduce(
    (sum, i) => sum + i.appliedAmountCents,
    0
  );

  try {
  // ── Step 1: Begin order edit ─────────────────────────────────────────────
  const beginData = await shopifyGraphql(shop, accessToken, ORDER_EDIT_BEGIN, { id: orderGid });
  const beginTopErr = extractGqlErrors(beginData?.errors);
  if (beginTopErr) {
    return json({ error: `orderEditBegin: ${beginTopErr}` }, { status: 422, headers: CORS_HEADERS });
  }
  const beginErrors = beginData?.data?.orderEditBegin?.userErrors;

  if (beginErrors?.length) {
    return json(
      { error: `orderEditBegin: ${beginErrors.map((e: { message: string }) => e.message).join("; ")}` },
      { status: 422, headers: CORS_HEADERS }
    );
  }

  const calculatedOrder = beginData?.data?.orderEditBegin?.calculatedOrder;
  if (!calculatedOrder) {
    return json(
      { error: "Could not begin order edit." },
      { status: 422, headers: CORS_HEADERS }
    );
  }

  const calculatedOrderId: string = calculatedOrder.id;

  // ── Step 2: Remove any legacy EHF custom line item (old approach) ────────
  const existingEhfLine = calculatedOrder.lineItems?.edges?.find(
    (e: { node: { id: string; title: string } }) =>
      e.node.title === EHF_LINE_ITEM_TITLE
  );
  if (existingEhfLine) {
    await shopifyGraphql(shop, accessToken, ORDER_EDIT_SET_QTY, {
      id: calculatedOrderId,
      lineItemId: existingEhfLine.node.id,
      quantity: 0,
    });
  }

  // ── Step 3: Remove existing EHF shipping line if present ────────────────
  const existingEhfShippingLine = (calculatedOrder.shippingLines as { id: string; title: string }[] ?? [])
    .find((sl) => sl.title === EHF_LINE_ITEM_TITLE);
  if (existingEhfShippingLine) {
    const removeData = await shopifyGraphql(shop, accessToken, ORDER_EDIT_REMOVE_SHIPPING_LINE, {
      id: calculatedOrderId,
      shippingLineId: existingEhfShippingLine.id,
    });
    const removeErrors = removeData?.data?.orderEditRemoveShippingLine?.userErrors;
    if (removeErrors?.length) {
      console.error("EHF shipping line remove errors:", removeErrors);
    }
  }

  // ── Step 4: Add EHF as a shipping line (only if total > 0) ──────────────
  // Shipping lines appear in the order totals section (below subtotal, above
  // taxes) rather than as a product SKU, and do not create a fulfillment order.
  let newLineItemId: string | null = null;

  if (totalAmountCents > 0) {
    const addData = await shopifyGraphql(shop, accessToken, ORDER_EDIT_ADD_SHIPPING_LINE, {
      id: calculatedOrderId,
      shippingLine: {
        title: EHF_LINE_ITEM_TITLE,
        price: { amount: (totalAmountCents / 100).toFixed(2), currencyCode: "CAD" },
      },
    });
    const addTopErr = extractGqlErrors(addData?.errors);
    if (addTopErr) {
      return json({ error: `orderEditAddShippingLine: ${addTopErr}` }, { status: 422, headers: CORS_HEADERS });
    }
    const addErrors = addData?.data?.orderEditAddShippingLine?.userErrors;
    if (addErrors?.length) {
      return json(
        { error: `orderEditAddShippingLine: ${addErrors.map((e: { message: string }) => e.message).join("; ")}` },
        { status: 422, headers: CORS_HEADERS }
      );
    }
    newLineItemId =
      addData?.data?.orderEditAddShippingLine?.calculatedShippingLine?.id ?? null;
  }

  // ── Step 5: Commit ────────────────────────────────────────────────────────
  const staffNote =
    totalAmountCents > 0
      ? `EHF applied: $${(totalAmountCents / 100).toFixed(2)} CAD`
      : "EHF removed from order.";

  const commitData = await shopifyGraphql(shop, accessToken, ORDER_EDIT_COMMIT, {
    id: calculatedOrderId,
    notifyCustomer: false,
    staffNote,
  });
  const commitTopErr = extractGqlErrors(commitData?.errors);
  if (commitTopErr) {
    return json({ error: `orderEditCommit: ${commitTopErr}` }, { status: 422, headers: CORS_HEADERS });
  }
  const commitErrors = commitData?.data?.orderEditCommit?.userErrors;

  if (commitErrors?.length) {
    return json(
      { error: `orderEditCommit: ${commitErrors.map((e: { message: string }) => e.message).join("; ")}` },
      { status: 422, headers: CORS_HEADERS }
    );
  }

  const orderName: string =
    commitData?.data?.orderEditCommit?.order?.name ?? "";

  // ── Step 6: Store breakdown in order metafield ────────────────────────────
  if (totalAmountCents > 0) {
    await shopifyGraphql(shop, accessToken, METAFIELDS_SET, {
      metafields: [
        {
          ownerId: orderGid,
          namespace: "ehf_manager",
          key: "line_breakdown",
          type: "json",
          value: JSON.stringify(
            chargedItems.map((i) => ({
              lineItemId: i.lineItemId,
              title: i.title,
              sku: i.sku,
              appliedAmountCents: i.appliedAmountCents,
              isOverride: i.isOverride,
              overrideReason: i.overrideReason,
            }))
          ),
        },
      ],
    });
  }

  // ── Step 7: Save audit record in Postgres ─────────────────────────────────
  await saveEhfApplication({
    orderId,
    orderName,
    shopDomain: shop,
    provinceCode: body.provinceCode ?? "",
    totalAmountCents,
    lineBreakdown: lineItems,
    shopifyLineItemId: newLineItemId,
    appliedBy: staffUser as string | null,
  });

  return json(
    {
      success: true,
      totalAmountCents,
      orderName,
    },
    { headers: CORS_HEADERS }
  );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(
      { error: `Unexpected error: ${msg}` },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
