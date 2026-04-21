import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import {
  saveEhfApplication,
  EHF_LINE_ITEM_TITLE,
  type ApplyLineItemInput,
} from "../ehf.server";

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
            node {
              id
              title
            }
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
  ) {
    orderEditAddCustomItem(
      id: $id
      title: $title
      quantity: $quantity
      price: $price
      taxable: $taxable
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

  const { shop, orderId, lineItems } = body;

  if (!shop || !orderId || !Array.isArray(lineItems)) {
    return json(
      { error: "shop, orderId, and lineItems are required." },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { admin, session } = await unauthenticated.admin(shop);

  // Normalize to full GID — extension may return a numeric ID
  const orderGid = orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const chargedItems = lineItems.filter((i) => i.chargeEhf);
  const totalAmountCents = chargedItems.reduce(
    (sum, i) => sum + i.appliedAmountCents,
    0
  );

  // ── Step 1: Begin order edit ─────────────────────────────────────────────
  const beginRes = await admin.graphql(ORDER_EDIT_BEGIN, {
    variables: { id: orderGid },
  });
  const beginData = await beginRes.json();
  const beginErrors = beginData?.data?.orderEditBegin?.userErrors;

  if (beginErrors?.length) {
    return json(
      { error: beginErrors.map((e: { message: string }) => e.message).join("; ") },
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

  // ── Step 2: Remove existing EHF line item if present ────────────────────
  const existingEhfLine = calculatedOrder.lineItems?.edges?.find(
    (e: { node: { id: string; title: string } }) =>
      e.node.title === EHF_LINE_ITEM_TITLE
  );

  if (existingEhfLine) {
    const removeRes = await admin.graphql(ORDER_EDIT_SET_QTY, {
      variables: {
        id: calculatedOrderId,
        lineItemId: existingEhfLine.node.id,
        quantity: 0,
      },
    });
    const removeData = await removeRes.json();
    const removeErrors =
      removeData?.data?.orderEditSetLineItemQuantity?.userErrors;
    if (removeErrors?.length) {
      console.error("EHF remove errors:", removeErrors);
      // Non-fatal — continue to add the new line item
    }
  }

  // ── Step 3: Add combined EHF line item (only if total > 0) ───────────────
  let newLineItemId: string | null = null;

  if (totalAmountCents > 0) {
    const addRes = await admin.graphql(ORDER_EDIT_ADD_CUSTOM, {
      variables: {
        id: calculatedOrderId,
        title: EHF_LINE_ITEM_TITLE,
        quantity: 1,
        price: {
          amount: (totalAmountCents / 100).toFixed(2),
          currencyCode: "CAD",
        },
        taxable: false,
      },
    });
    const addData = await addRes.json();
    const addErrors = addData?.data?.orderEditAddCustomItem?.userErrors;

    if (addErrors?.length) {
      return json(
        { error: addErrors.map((e: { message: string }) => e.message).join("; ") },
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

  const commitRes = await admin.graphql(ORDER_EDIT_COMMIT, {
    variables: {
      id: calculatedOrderId,
      notifyCustomer: false,
      staffNote,
    },
  });
  const commitData = await commitRes.json();
  const commitErrors = commitData?.data?.orderEditCommit?.userErrors;

  if (commitErrors?.length) {
    return json(
      { error: commitErrors.map((e: { message: string }) => e.message).join("; ") },
      { status: 422, headers: CORS_HEADERS }
    );
  }

  const orderName: string =
    commitData?.data?.orderEditCommit?.order?.name ?? "";

  // ── Step 5: Store breakdown in order metafield ────────────────────────────
  if (totalAmountCents > 0) {
    await admin.graphql(METAFIELDS_SET, {
      variables: {
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
      },
    });
  }

  // ── Step 6: Save audit record in Postgres ─────────────────────────────────
  const staffUser = session.email ?? session.onlineAccessInfo?.associated_user?.email ?? null;

  await saveEhfApplication({
    orderId,
    orderName,
    shopDomain: session.shop,
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
}
