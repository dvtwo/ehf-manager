import React, { useState, useEffect, useCallback } from "react";
import {
  reactExtension,
  useApi,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Spinner,
  Divider,
  Box,
  Checkbox,
  TextField,
  Badge,
} from "@shopify/ui-extensions-react/admin";

// ⚠️  UPDATE THIS before deploying to production.
// Local dev: leave as "" — shopify app dev injects the tunnel URL automatically.
// Production: set to your Render URL, e.g. "https://ehf-manager.onrender.com"
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");

export default reactExtension(
  "admin.order-details.block.render",
  () => <EHFBlock />
);

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface OrderEhfResponse {
  orderId: string;
  orderName: string;
  provinceCode: string;
  province: string;
  lineItems: LineItemState[];
  existingApplication: {
    totalAmountCents: number;
    appliedBy: string | null;
    appliedAt: string;
  } | null;
}

// ── Root block component ──────────────────────────────────────────────────────

function EHFBlock() {
  const { data, sessionToken } = useApi("admin.order-details.block.render");

  const [ehfData, setEhfData] = useState<OrderEhfResponse | null>(null);
  const [lineItems, setLineItems] = useState<LineItemState[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const orderId: string | undefined = (data as { order?: { id?: string } })
    ?.order?.id;

  const fetchOrderData = useCallback(async () => {
    if (!orderId) return;
    try {
      setLoading(true);
      setErrorMsg(null);
      const token = await sessionToken.get();
      const res = await fetch(
        `${APP_URL}/api/ehf/order/${encodeURIComponent(orderId)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
      }
      const result: OrderEhfResponse = await res.json();
      setEhfData(result);
      setLineItems(result.lineItems);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load EHF data.");
    } finally {
      setLoading(false);
    }
  }, [orderId, sessionToken]);

  useEffect(() => {
    fetchOrderData();
  }, [fetchOrderData]);

  const updateItem = useCallback(
    (id: string, patch: Partial<LineItemState>) => {
      setLineItems((prev) =>
        prev.map((item) => (item.lineItemId === id ? { ...item, ...patch } : item))
      );
    },
    []
  );

  const totalEhfCents = lineItems
    .filter((i) => i.chargeEhf)
    .reduce((sum, i) => sum + i.appliedAmountCents, 0);

  const handleApply = useCallback(async () => {
    if (!orderId || !ehfData) return;
    try {
      setSaving(true);
      setErrorMsg(null);
      setSuccessMsg(null);
      const token = await sessionToken.get();
      const res = await fetch(`${APP_URL}/api/ehf/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId,
          provinceCode: ehfData.provinceCode,
          lineItems: lineItems.map((i) => ({
            lineItemId: i.lineItemId,
            title: i.title,
            sku: i.sku || null,
            chargeEhf: i.chargeEhf,
            suggestedAmountCents: i.suggestedAmountCents,
            appliedAmountCents: i.chargeEhf ? i.appliedAmountCents : 0,
            isOverride: i.isOverride,
            overrideReason: i.overrideReason,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
      }
      const result = await res.json();
      setSuccessMsg(
        `EHF ${ehfData.existingApplication ? "updated" : "applied"}: ${fmt(
          result.totalAmountCents
        )} added to order ${result.orderName}.`
      );
      await fetchOrderData();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to apply EHF.");
    } finally {
      setSaving(false);
    }
  }, [orderId, ehfData, lineItems, sessionToken, fetchOrderData]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <BlockStack gap="base">
        <Text fontWeight="bold">EHF Manager</Text>
        <InlineStack gap="base" blockAlignment="center">
          <Spinner size="small" />
          <Text>Loading EHF data…</Text>
        </InlineStack>
      </BlockStack>
    );
  }

  if (!ehfData) {
    return (
      <BlockStack gap="base">
        <Text fontWeight="bold">EHF Manager</Text>
        {errorMsg && (
          <Banner tone="critical">
            <Text>{errorMsg}</Text>
          </Banner>
        )}
        <Button onPress={fetchOrderData}>Retry</Button>
      </BlockStack>
    );
  }

  const hasProvince = !!ehfData.provinceCode;

  return (
    <BlockStack gap="base">
      {/* Header */}
      <InlineStack gap="small" blockAlignment="center">
        <Text fontWeight="bold">EHF Manager</Text>
        {ehfData.existingApplication ? (
          <Badge tone="success">EHF Applied</Badge>
        ) : (
          <Badge tone="attention">Pending</Badge>
        )}
      </InlineStack>

      <Text>
        Ship-to:{" "}
        <Text fontWeight="semibold">
          {hasProvince
            ? `${ehfData.province} (${ehfData.provinceCode})`
            : "No province on file — EHF cannot be calculated automatically"}
        </Text>
      </Text>

      {ehfData.existingApplication && (
        <Banner tone="success">
          <Text>
            {fmt(ehfData.existingApplication.totalAmountCents)} EHF on order
            {ehfData.existingApplication.appliedBy
              ? ` · applied by ${ehfData.existingApplication.appliedBy}`
              : ""}
          </Text>
        </Banner>
      )}

      {errorMsg && (
        <Banner tone="critical">
          <Text>{errorMsg}</Text>
        </Banner>
      )}
      {successMsg && (
        <Banner tone="success">
          <Text>{successMsg}</Text>
        </Banner>
      )}

      <Divider />

      {/* Line items */}
      <BlockStack gap="loose">
        {lineItems.map((item) => (
          <LineItemRow
            key={item.lineItemId}
            item={item}
            onUpdate={(patch) => updateItem(item.lineItemId, patch)}
          />
        ))}
      </BlockStack>

      <Divider />

      {/* Footer */}
      <InlineStack gap="base" blockAlignment="center" inlineAlignment="end">
        <Text>
          Total EHF:{" "}
          <Text fontWeight="bold">{fmt(totalEhfCents)}</Text>
        </Text>
        <Button
          variant="primary"
          onPress={handleApply}
          disabled={saving}
        >
          {saving
            ? "Saving…"
            : ehfData.existingApplication
            ? "Update EHF"
            : "Apply EHF"}
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
  const handleToggleCharge = useCallback(
    (checked: boolean) => {
      onUpdate({
        chargeEhf: checked,
        appliedAmountCents: checked ? item.suggestedAmountCents : 0,
        isOverride: false,
      });
    },
    [item.suggestedAmountCents, onUpdate]
  );

  const handleToggleOverride = useCallback(
    (checked: boolean) => {
      onUpdate({
        isOverride: checked,
        appliedAmountCents: checked ? item.appliedAmountCents : item.suggestedAmountCents,
      });
    },
    [item.appliedAmountCents, item.suggestedAmountCents, onUpdate]
  );

  const handleAmountChange = useCallback(
    (val: string) => {
      const cents = Math.max(0, Math.round(parseFloat(val || "0") * 100));
      onUpdate({ appliedAmountCents: cents });
    },
    [onUpdate]
  );

  return (
    <BlockStack gap="tight">
      {/* Product row */}
      <InlineStack gap="small" blockAlignment="start">
        <Checkbox checked={item.chargeEhf} onChange={handleToggleCharge}>
          <BlockStack gap="none">
            <Text fontWeight="semibold">{item.title}</Text>
            <Text tone="subdued">
              SKU: {item.sku || "—"} · Qty: {item.quantity}
              {item.categoryName ? ` · ${item.categoryName}` : ""}
            </Text>
          </BlockStack>
        </Checkbox>
      </InlineStack>

      {/* EHF details, only when charging */}
      {item.chargeEhf && (
        <Box paddingInlineStart="400">
          <BlockStack gap="tight">
            <Text>
              Suggested:{" "}
              <Text fontWeight="semibold">{fmt(item.suggestedAmountCents)}</Text>
              {item.suggestedAmountCents === 0 && (
                <Text tone="subdued"> (no rate on file)</Text>
              )}
            </Text>

            <Checkbox checked={item.isOverride} onChange={handleToggleOverride}>
              Override amount
            </Checkbox>

            {item.isOverride && (
              <BlockStack gap="tight">
                <TextField
                  label="Override amount (CAD)"
                  type="number"
                  value={String((item.appliedAmountCents / 100).toFixed(2))}
                  onChange={handleAmountChange}
                />
                <TextField
                  label="Override reason (required)"
                  value={item.overrideReason}
                  onChange={(v) => onUpdate({ overrideReason: v })}
                  multiline={2}
                />
              </BlockStack>
            )}

            {!item.isOverride && (
              <Text>
                Will charge:{" "}
                <Text fontWeight="semibold">{fmt(item.suggestedAmountCents)}</Text>
              </Text>
            )}
          </BlockStack>
        </Box>
      )}
    </BlockStack>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
