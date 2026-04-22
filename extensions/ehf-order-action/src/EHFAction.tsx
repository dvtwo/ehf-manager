import {
  reactExtension,
  useApi,
  AdminAction,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  ProgressIndicator,
  Divider,
  Checkbox,
  NumberField,
  TextArea,
  Badge,
  Select,
} from "@shopify/ui-extensions-react/admin";
import React, { useState, useEffect, useCallback } from "react";

const APP_URL = typeof process !== "undefined" && process.env?.APP_URL
  ? process.env.APP_URL.replace(/\/$/, "")
  : "https://ehf-manager.onrender.com";

const EHF_TITLE = "Environmental Handling Fee";

export default reactExtension(
  "admin.order-details.action.render",
  () => <EHFAction />
);

interface CategoryOption { id: string; name: string; rateCents: number; }
interface LineItemState {
  lineItemId: string;
  title: string;
  sku: string;
  quantity: number;
  suggestedAmountCents: number;
  categoryName: string | null;
  selectedCategoryId: string | null;
  chargeEhf: boolean;
  appliedAmountCents: number;
  isOverride: boolean;
  overrideReason: string;
}
interface ExistingApplication {
  totalAmountCents: number;
  appliedBy: string | null;
  appliedAt: string;
  lineBreakdown: { lineItemId: string; chargeEhf: boolean; appliedAmountCents: number; isOverride: boolean; overrideReason: string; }[];
}

const GET_ORDER = `
  query GetOrderForEhf($id: ID!) {
    order(id: $id) {
      name
      shippingAddress { provinceCode province }
      lineItems(first: 100) {
        edges { node { id title quantity sku } }
      }
    }
    shop { myshopifyDomain }
  }
`;

function EHFAction() {
  const api = useApi("admin.order-details.action.render");
  const orderId = api.data.selected?.[0]?.id;
  const query = api.query;

  const [orderInfo, setOrderInfo] = useState<{ orderId: string; orderName: string; shop: string; provinceCode: string; province: string } | null>(null);
  const [lineItems, setLineItems] = useState<LineItemState[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
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
      const { data, errors } = await query(GET_ORDER, { variables: { id: orderId } }) as any;
      if (errors?.length) throw new Error(errors[0].message);

      const order = data?.order;
      const shop: string = data?.shop?.myshopifyDomain ?? "";
      const provinceCode: string = order?.shippingAddress?.provinceCode?.toUpperCase() ?? "";
      const province: string = order?.shippingAddress?.province ?? provinceCode;

      const rawItems = order.lineItems.edges
        .filter((e: any) => !e.node.title.startsWith(EHF_TITLE))
        .map((e: any) => ({ id: e.node.id, title: e.node.title, sku: e.node.sku ?? "", quantity: e.node.quantity }));

      const skus = rawItems.map((i: any) => i.sku).filter(Boolean).join(",");
      const ratesRes = await fetch(
        `${APP_URL}/api/ehf/rates?province=${encodeURIComponent(provinceCode)}&orderId=${encodeURIComponent(orderId)}&skus=${encodeURIComponent(skus)}`
      );
      if (!ratesRes.ok) throw new Error(`HTTP ${ratesRes.status} from rates API`);
      const ratesData: { rates: Record<string, { amountCents: number; categoryName: string | null }>; categories: CategoryOption[]; existingApplication: ExistingApplication | null } = await ratesRes.json();

      const prevMap = new Map((ratesData.existingApplication?.lineBreakdown ?? []).map((p) => [p.lineItemId, p]));
      const items: LineItemState[] = rawItems.map((item: any) => {
        const rate = ratesData.rates?.[item.sku] ?? { amountCents: 0, categoryName: null };
        const prev = prevMap.get(item.id);
        return {
          lineItemId: item.id,
          title: item.title,
          sku: item.sku,
          quantity: item.quantity,
          suggestedAmountCents: rate.amountCents,
          categoryName: rate.categoryName,
          selectedCategoryId: null,
          chargeEhf: prev ? prev.chargeEhf : rate.amountCents > 0,
          appliedAmountCents: prev ? (prev.isOverride ? prev.appliedAmountCents : rate.amountCents) : rate.amountCents,
          isOverride: prev?.isOverride ?? false,
          overrideReason: prev?.overrideReason ?? "",
        };
      });

      setOrderInfo({ orderId, orderName: order.name, shop, provinceCode, province });
      setLineItems(items);
      setCategories(ratesData.categories ?? []);
      setExistingApp(ratesData.existingApplication);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load EHF data.");
    } finally {
      setLoading(false);
    }
  }, [orderId, query]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateItem = useCallback((id: string, patch: Partial<LineItemState>) => {
    setLineItems((prev) => prev.map((item) => item.lineItemId === id ? { ...item, ...patch } : item));
  }, []);

  const totalCents = lineItems.filter((i) => i.chargeEhf).reduce((s, i) => s + i.appliedAmountCents, 0);

  const handleApply = useCallback(async () => {
    if (!orderInfo) return;
    try {
      setSaving(true);
      setErrorMsg(null);
      setSuccessMsg(null);
      const res = await fetch(`${APP_URL}/api/ehf/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: orderInfo.shop, orderId: orderInfo.orderId, provinceCode: orderInfo.provinceCode, lineItems }),
      });
      const result = await res.json() as any;
      if (!res.ok || result.error) throw new Error(result.error ?? `HTTP ${res.status}`);
      setSuccessMsg(`${fmt(result.totalAmountCents ?? totalCents)} EHF ${existingApp ? "updated" : "applied"} on ${orderInfo.orderName}.`);
      await loadData();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to apply EHF.");
    } finally {
      setSaving(false);
    }
  }, [orderInfo, totalCents, lineItems, existingApp, loadData]);

  if (loading) {
    return (
      <AdminAction title="Manage EHF" loading>
        <InlineStack gap="small" blockAlignment="center">
          <ProgressIndicator size="base" />
          <Text>Loading…</Text>
        </InlineStack>
      </AdminAction>
    );
  }

  const provinceLabel = orderInfo?.provinceCode
    ? `${orderInfo.province} (${orderInfo.provinceCode})`
    : "No province — EHF cannot be auto-calculated";

  return (
    <AdminAction
      title="Manage EHF"
      primaryAction={
        <Button variant="primary" onPress={handleApply} disabled={saving}>
          {saving ? "Saving…" : existingApp ? "Update EHF" : "Apply EHF"}
        </Button>
      }
      secondaryAction={
        <Button onPress={loadData}>Refresh</Button>
      }
    >
      <BlockStack gap="base">
        <InlineStack gap="small" blockAlignment="center">
          <Badge tone={existingApp ? "success" : "warning"}>
            {existingApp ? "EHF Applied" : "Pending"}
          </Badge>
          <Text tone="subdued">{"Ship-to: " + provinceLabel}</Text>
        </InlineStack>

        {existingApp && (
          <Banner tone="success" title={`${fmt(existingApp.totalAmountCents)} EHF on order${existingApp.appliedBy ? ` · by ${existingApp.appliedBy}` : ""}`} />
        )}
        {errorMsg && <Banner tone="critical" title={errorMsg} />}
        {successMsg && <Banner tone="success" title={successMsg} />}

        <Divider />

        <BlockStack gap="base">
          {lineItems.map((item) => (
            <LineItemRow key={item.lineItemId} item={item} categories={categories} onUpdate={(patch) => updateItem(item.lineItemId, patch)} />
          ))}
        </BlockStack>

        <Divider />

        <InlineStack inlineAlignment="end">
          <Text fontWeight="bold">{"Total EHF: " + fmt(totalCents)}</Text>
        </InlineStack>
      </BlockStack>
    </AdminAction>
  );
}

interface RowProps { item: LineItemState; categories: CategoryOption[]; onUpdate: (patch: Partial<LineItemState>) => void; }

function LineItemRow({ item, categories, onUpdate }: RowProps) {
  const categoryOptions = [
    { value: "", label: "— select category —" },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  function handleCategoryChange(categoryId: string) {
    if (!categoryId) return;
    const cat = categories.find((c) => c.id === categoryId);
    if (!cat) return;
    onUpdate({ selectedCategoryId: categoryId, categoryName: cat.name, suggestedAmountCents: cat.rateCents, appliedAmountCents: item.isOverride ? item.appliedAmountCents : cat.rateCents, chargeEhf: cat.rateCents > 0 });
  }

  const chargeAmount = item.isOverride ? item.appliedAmountCents : item.suggestedAmountCents;
  const metaParts = [`${item.sku || "—"} ×${item.quantity}`, item.categoryName ?? null, item.chargeEhf ? fmt(chargeAmount) : null].filter(Boolean).join(" · ");

  return (
    <BlockStack gap="extraSmall">
      <Checkbox
        label={item.title}
        checked={item.chargeEhf}
        onChange={(checked) => onUpdate({ chargeEhf: checked, appliedAmountCents: checked ? item.suggestedAmountCents : 0, isOverride: false })}
      />
      <InlineStack gap="small" blockAlignment="center" inlineAlignment="space-between">
        <Text tone="subdued">{metaParts}</Text>
        {item.chargeEhf && (
          <Checkbox
            label="Override"
            checked={item.isOverride}
            onChange={(checked) => onUpdate({ isOverride: checked, appliedAmountCents: checked ? item.appliedAmountCents : item.suggestedAmountCents })}
          />
        )}
      </InlineStack>
      {!item.categoryName && (
        <Select label="Category" value={item.selectedCategoryId ?? ""} options={categoryOptions} onChange={handleCategoryChange} />
      )}
      {item.isOverride && (
        <BlockStack gap="extraSmall">
          <NumberField label="Override amount (CAD $)" value={item.appliedAmountCents / 100} onChange={(v) => onUpdate({ appliedAmountCents: Math.max(0, Math.round(v * 100)) })} min={0} />
          <TextArea label="Override reason (required)" value={item.overrideReason} onChange={(v) => onUpdate({ overrideReason: v })} rows={2} />
        </BlockStack>
      )}
    </BlockStack>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
