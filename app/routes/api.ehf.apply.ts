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

const ORDER_EDIT_ADD_CUSTOM = `#graphql
  mutation OrderEditAddCustomItem(
    $id: ID!
    $title: String!
    $quantity: Int!
    $price: MoneyInput!
    $taxable: Boolean!
    $requiresShipping: Boolean!
  ) {
    orderEditAddCustomItem(
      id: $id
      title: $title
      quantity: $quantity
      price: $price
      taxable: $taxable
      requiresShipping: $requiresShipping
    ) {
      calculatedLineItem { id }
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

  // Prefer the most-recently-created online session, then fall back to offline.
  const allSessions = await prisma.session.findMany({
    where: { shop },
    orderBy: { id: "desc" },
  });
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
  // ── $0 path: remove any lingering EHF lines and clear the DB record ───────
  // Runs regardless of whether EHF lines exist on the order — always resets
  // the badge to Pending. No commit needed if nothing was found to remove.
  if (totalAmountCents === 0) {
    const beginData = await shopifyGraphql(shop, accessToken, ORDER_EDIT_BEGIN, { id: orderGid });
    const calculatedOrder = beginData?.data?.orderEditBegin?.calculatedOrder;
    if (calculatedOrder) {
      const ehfLines = (calculatedOrder.lineItems?.edges ?? []).filter(
        (e: { node: { id: string; title: string } }) =>
          e.node.title.startsWith(EHF_LINE_ITEM_TITLE)
      );
      if (ehfLines.length > 0) {
        for (const line of ehfLines) {
          await shopifyGraphql(shop, accessToken, ORDER_EDIT_SET_QTY, {
            id: calculatedOrder.id,
            lineItemId: line.node.id,
            quantity: 0,
          });
        }
        await shopifyGraphql(shop, accessToken, ORDER_EDIT_COMMIT, {
          id: calculatedOrder.id,
          notifyCustomer: false,
          staffNote: "EHF removed from order.",
        });
      }
    }
    // Always delete the DB record so the badge resets to Pending.
    await prisma.ehfApplication.deleteMany({ where: { orderId } });
    return json({ success: true, totalAmountCents: 0, orderName: "" }, { headers: CORS_HEADERS });
  }

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
    return json({ error: "Could not begin order edit." }, { status: 422, headers: CORS_HEADERS });
  }

  const calculatedOrderId: string = calculatedOrder.id;

  // ── Step 2: Remove ALL existing EHF line items ───────────────────────────
  const existingEhfLines = (calculatedOrder.lineItems?.edges ?? []).filter(
    (e: { node: { id: string; title: string } }) =>
      e.node.title.startsWith(EHF_LINE_ITEM_TITLE)
  );
  for (const line of existingEhfLines) {
    await shopifyGraphql(shop, accessToken, ORDER_EDIT_SET_QTY, {
      id: calculatedOrderId,
      lineItemId: line.node.id,
      quantity: 0,
    });
  }

  // ── Step 3: Add EHF custom line item (only if total > 0) ─────────────────
  const chargedSkus = chargedItems.map((i) => i.sku).filter(Boolean).join(", ");
  const ehfTitle = chargedSkus
    ? `${EHF_LINE_ITEM_TITLE} (${chargedSkus})`
    : EHF_LINE_ITEM_TITLE;

  let newLineItemId: string | null = null;

  if (totalAmountCents > 0) {
    const addData = await shopifyGraphql(shop, accessToken, ORDER_EDIT_ADD_CUSTOM, {
      id: calculatedOrderId,
      title: ehfTitle,
      quantity: 1,
      price: { amount: (totalAmountCents / 100).toFixed(2), currencyCode: "CAD" },
      taxable: false,
      requiresShipping: false,
    });
    const addTopErr = extractGqlErrors(addData?.errors);
    if (addTopErr) {
      return json({ error: `orderEditAddCustomItem: ${addTopErr}` }, { status: 422, headers: CORS_HEADERS });
    }
    const addErrors = addData?.data?.orderEditAddCustomItem?.userErrors;
    if (addErrors?.length) {
      return json(
        { error: `orderEditAddCustomItem: ${addErrors.map((e: { message: string }) => e.message).join("; ")}` },
        { status: 422, headers: CORS_HEADERS }
      );
    }
    newLineItemId =
      addData?.data?.orderEditAddCustomItem?.calculatedLineItem?.id ?? null;
  }

  // ── Step 4: Commit ────────────────────────────────────────────────────────
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

  // ── Step 5: Store breakdown in order metafield ────────────────────────────
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

  // ── Step 6: Save or delete audit record in Postgres ──────────────────────
  if (totalAmountCents === 0) {
    // Remove the record so existingApplication returns null and the badge
    // correctly shows "Pending" instead of "EHF Applied".
    await prisma.ehfApplication.deleteMany({ where: { orderId } });
  } else {
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
  }

  return json(
    { success: true, totalAmountCents, orderName },
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
