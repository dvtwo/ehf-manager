import React, { useState, useEffect, useCallback } from "react";
import {
  reactExtension,
  useApi,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  ProgressIndicator,
  Divider,
  Box,
  Checkbox,
  NumberField,
  TextArea,
  Badge,
} from "@shopify/ui-extensions-react/admin";

const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");

const EHF_TITLE = "Environmental Handling Fee";

export default reactExtension(
  "admin.order-details.block.render",
  () => <EHFBlock />
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrderInfo {
  orderId: string;
  orderName: string;
  shop: string;
  provinceCode: string;
  province: string;
}

interface LineItemState {
  lineItemId: string;
  title: string;
  sku: string;
  quantity: number;
  suggestedAmountCents: number;
  categoryName: string | null;
  chargeEhf: boolean;
  appliedAmountCents: number;
  isOverride: boolean;
  overrideReason: string;
}

interface ExistingApplication {
  totalAmountCents: number;
  appliedBy: string | null;
  appliedAt: string;
  lineBreakdown: {
    lineItemId: string;
    chargeEhf: boolean;
    appliedAmountCents: number;
    isOverride: boolean;
    overrideReason: string;
  }[];
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

const GET_ORDER = `
  query GetOrderForEhf($id: ID!) {
    order(id: $id) {
      name
      shippingAddress { provinceCode province }
      lineItems(first: 100) {
        edges {
          node {
            id
            title
            quantity
            variant { sku }
          }
        }
      }
    }
    shop { myshopifyDomain }
  }
`;

const ORDER_EDIT_BEGIN = `
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        lineItems(first: 100) {
          edges { node { id title } }
        }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_SET_QTY = `
  mutation OrderEditSetQty($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetLineItemQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_ADD_CUSTOM = `
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

const ORDER_EDIT_COMMIT = `
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id name }
      userErrors { field message }
    }
  }
`;

// ── Root block ────────────────────────────────────────────────────────────────

function EHFBlock() {
  const { data, query } = useApi("admin.order-details.block.render");
  const orderId = data.selected?.[0]?.id;

  const [orderInfo, setOrderInfo] = useState<OrderInfo | null>(null);
  const [lineItems, setLineItems] = useState<LineItemState[]>([]);
  const [existingApp, setExistingApp] = useState<ExistingApplication | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!orderId) return;
    try {
      setLoading(true);
      setErrorMsg(null);

      const { data: gqlData, errors: gqlErrors } = await query(GET_ORDER, {
        variables: { id: orderId },
      });
      if (gqlErrors?.length) throw new Error(gqlErrors[0].message);

      const order = (gqlData as any).order;
      const shop: string = (gqlData as any).shop?.myshopifyDomain ?? "";
      const provinceCode: string = order.shippingAddress?.provinceCode?.toUpperCase() ?? "";
      const province: string = order.shippingAddress?.province ?? provinceCode;

      const rawItems: { id: string; title: string; sku: string; quantity: number }[] =
        order.lineItems.edges
          .filter((e: any) => e.node.title !== EHF_TITLE)
          .map((e: any) => ({
            id: e.node.id,
            title: e.node.title,
            sku: e.node.variant?.sku ?? "",
            quantity: e.node.quantity,
          }));

      const skus = rawItems.map((i) => i.sku).filter(Boolean).join(",");
      const ratesRes = await fetch(
        `${APP_URL}/api/ehf/rates?province=${encodeURIComponent(provinceCode)}&orderId=${encodeURIComponent(orderId)}&skus=${encodeURIComponent(skus)}`
      );
      if (!ratesRes.ok) throw new Error("Could not load EHF rates from server.");
      const ratesData: {
        rates: Record<string, { amountCents: number; categoryName: string | null }>;
        existingApplication: ExistingApplication | null;
      } = await ratesRes.json();

      const prevMap = new Map(
        (ratesData.existingApplication?.lineBreakdown ?? []).map((p) => [p.lineItemId, p])
      );
      const items: LineItemState[] = rawItems.map((item) => {
        const rate = ratesData.rates?.[item.sku] ?? { amountCents: 0, categoryName: null };
        const prev = prevMap.get(item.id);
        return {
          lineItemId: item.id,
          title: item.title,
          sku: item.sku,
          quantity: item.quantity,
          suggestedAmountCents: rate.amountCents,
          categoryName: rate.categoryName,
          chargeEhf: prev ? prev.chargeEhf : rate.amountCents > 0,
          appliedAmountCents: prev
            ? prev.isOverride
              ? prev.appliedAmountCents
              : rate.amountCents
            : rate.amountCents,
          isOverride: prev?.isOverride ?? false,
          overrideReason: prev?.overrideReason ?? "",
        };
      });

      setOrderInfo({ orderId, orderName: order.name, shop, provinceCode, province });
      setLineItems(items);
      setExistingApp(ratesData.existingApplication);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load EHF data.");
    } finally {
      setLoading(false);
    }
  }, [orderId, query]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const updateItem = useCallback((id: string, patch: Partial<LineItemState>) => {
    setLineItems((prev) =>
      prev.map((item) => (item.lineItemId === id ? { ...item, ...patch } : item))
    );
  }, []);

  const totalCents = lineItems
    .filter((i) => i.chargeEhf)
    .reduce((s, i) => s + i.appliedAmountCents, 0);

  const handleApply = useCallback(async () => {
    if (!orderInfo) return;
    try {
      setSaving(true);
      setErrorMsg(null);
      setSuccessMsg(null);

      const { data: beginData, errors: beginErrors } = await query(ORDER_EDIT_BEGIN, {
        variables: { id: orderInfo.orderId },
      });
      if (beginErrors?.length) throw new Error(beginErrors[0].message);
      const beginResult = (beginData as any).orderEditBegin;
      if (beginResult.userErrors?.length) throw new Error(beginResult.userErrors[0].message);

      const calcOrderId: string = beginResult.calculatedOrder.id;
      const existingEhfLine = beginResult.calculatedOrder.lineItems.edges.find(
        (e: any) => e.node.title === EHF_TITLE
      );

      if (existingEhfLine) {
        const { data: removeData } = await query(ORDER_EDIT_SET_QTY, {
          variables: { id: calcOrderId, lineItemId: existingEhfLine.node.id, quantity: 0 },
        });
        const removeErrors = (removeData as any).orderEditSetLineItemQuantity?.userErrors;
        if (removeErrors?.length) throw new Error(removeErrors[0].message);
      }

      if (totalCents > 0) {
        const { data: addData } = await query(ORDER_EDIT_ADD_CUSTOM, {
          variables: {
            id: calcOrderId,
            title: EHF_TITLE,
            quantity: 1,
            price: { amount: (totalCents / 100).toFixed(2), currencyCode: "CAD" },
            taxable: false,
          },
        });
        const addErrors = (addData as any).orderEditAddCustomItem?.userErrors;
        if (addErrors?.length) throw new Error(addErrors[0].message);
      }

      const { data: commitData } = await query(ORDER_EDIT_COMMIT, {
        variables: {
          id: calcOrderId,
          notifyCustomer: false,
          staffNote:
            totalCents > 0
              ? `EHF applied: $${(totalCents / 100).toFixed(2)} CAD`
              : "EHF removed from order.",
        },
      });
      const commitErrors = (commitData as any).orderEditCommit?.userErrors;
      if (commitErrors?.length) throw new Error(commitErrors[0].message);

      fetch(`${APP_URL}/api/ehf/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: orderInfo.shop,
          orderId: orderInfo.orderId,
          orderName: orderInfo.orderName,
          provinceCode: orderInfo.provinceCode,
          totalAmountCents: totalCents,
          lineBreakdown: lineItems,
        }),
      }).catch(() => {});

      setSuccessMsg(
        `${fmt(totalCents)} EHF ${existingApp ? "updated" : "applied"} on ${orderInfo.orderName}.`
      );
      await loadData();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to apply EHF.");
    } finally {
      setSaving(false);
    }
  }, [orderInfo, totalCents, lineItems, existingApp, query, loadData]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <BlockStack gap="base">
        <Text fontWeight="bold">EHF Manager</Text>
        <InlineStack gap="small" blockAlignment="center">
          <ProgressIndicator size="base" />
          <Text>Loading EHF data…</Text>
        </InlineStack>
      </BlockStack>
    );
  }

  if (!orderInfo) {
    return (
      <BlockStack gap="base">
        <Text fontWeight="bold">EHF Manager</Text>
        {errorMsg && <Banner tone="critical" title={errorMsg} />}
        <Button onPress={loadData}>Retry</Button>
      </BlockStack>
    );
  }

  const provinceLabel = orderInfo.provinceCode
    ? `${orderInfo.province} (${orderInfo.provinceCode})`
    : "No province on file — EHF cannot be auto-calculated";

  return (
    <BlockStack gap="base">
      <InlineStack gap="small" blockAlignment="center">
        <Text fontWeight="bold">EHF Manager</Text>
        <Badge tone={existingApp ? "success" : "warning"}>
          {existingApp ? "EHF Applied" : "Pending"}
        </Badge>
      </InlineStack>

      <Text>Ship-to: {provinceLabel}</Text>

      {existingApp && (
        <Banner
          tone="success"
          title={`${fmt(existingApp.totalAmountCents)} EHF on order${existingApp.appliedBy ? ` · applied by ${existingApp.appliedBy}` : ""}`}
        />
      )}
      {errorMsg && <Banner tone="critical" title={errorMsg} />}
      {successMsg && <Banner tone="success" title={successMsg} />}

      <Divider />

      <BlockStack gap="large">
        {lineItems.map((item) => (
          <LineItemRow
            key={item.lineItemId}
            item={item}
            onUpdate={(patch) => updateItem(item.lineItemId, patch)}
          />
        ))}
      </BlockStack>

      <Divider />

      <InlineStack gap="base" blockAlignment="center" inlineAlignment="end">
        <Text>Total EHF: {fmt(totalCents)}</Text>
        <Button variant="primary" onPress={handleApply} disabled={saving}>
          {saving ? "Saving…" : existingApp ? "Update EHF" : "Apply EHF"}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

// ── Per-line-item row ─────────────────────────────────────────────────────────

interface RowProps {
  item: LineItemState;
  onUpdate: (patch: Partial<LineItemState>) => void;
}

function LineItemRow({ item, onUpdate }: RowProps) {
  const skuInfo = `SKU: ${item.sku || "—"} · Qty: ${item.quantity}${
    item.categoryName ? ` · ${item.categoryName}` : " · (no category — set one in EHF Rules)"
  }`;

  return (
    <BlockStack gap="small">
      <Checkbox
        label={item.title}
        checked={item.chargeEhf}
        onChange={(checked) =>
          onUpdate({
            chargeEhf: checked,
            appliedAmountCents: checked ? item.suggestedAmountCents : 0,
            isOverride: false,
          })
        }
      />
      <Text>{skuInfo}</Text>

      {item.chargeEhf && (
        <Box paddingInlineStart="large">
          <BlockStack gap="small">
            <Text>
              {`Suggested: ${fmt(item.suggestedAmountCents)}${
                item.suggestedAmountCents === 0 ? " — no rate on file" : ""
              }`}
            </Text>

            <Checkbox
              label="Override amount"
              checked={item.isOverride}
              onChange={(checked) =>
                onUpdate({
                  isOverride: checked,
                  appliedAmountCents: checked
                    ? item.appliedAmountCents
                    : item.suggestedAmountCents,
                })
              }
            />

            {item.isOverride ? (
              <BlockStack gap="small">
                <NumberField
                  label="Override amount (CAD $)"
                  value={item.appliedAmountCents / 100}
                  onChange={(v) =>
                    onUpdate({ appliedAmountCents: Math.max(0, Math.round(v * 100)) })
                  }
                  min={0}
                />
                <TextArea
                  label="Override reason (required)"
                  value={item.overrideReason}
                  onChange={(v) => onUpdate({ overrideReason: v })}
                  rows={2}
                />
              </BlockStack>
            ) : (
              <Text>{`Will charge: ${fmt(item.suggestedAmountCents)}`}</Text>
            )}
          </BlockStack>
        </Box>
      )}
    </BlockStack>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
