import {
  reactExtension,
  useApi,
  BlockStack,
  Text,
  Button,
  Banner,
  ProgressIndicator,
  InlineStack,
  Badge,
} from "@shopify/ui-extensions-react/admin";
import React, { useState, useEffect, useCallback } from "react";

const APP_URL = typeof process !== "undefined" && process.env?.APP_URL
  ? process.env.APP_URL.replace(/\/$/, "")
  : "https://ehf-manager.onrender.com";

const EHF_TITLE = "Environmental Handling Fee";

export default reactExtension(
  "admin.order-details.block.render",
  () => <EHFBlock />
);

const GET_ORDER = `
  query GetOrderForEhf($id: ID!) {
    order(id: $id) {
      name
      shippingAddress { provinceCode province }
    }
    shop { myshopifyDomain }
  }
`;

function EHFBlock() {
  const api = useApi("admin.order-details.block.render");
  const orderId = api.data.selected?.[0]?.id;
  const query = api.query;

  const [status, setStatus] = useState<{
    province: string;
    provinceCode: string;
    existing: { totalAmountCents: number; appliedBy: string | null; appliedAt: string } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
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

      const ratesRes = await fetch(
        `${APP_URL}/api/ehf/rates?province=${encodeURIComponent(provinceCode)}&orderId=${encodeURIComponent(orderId)}&skus=`
      );
      const ratesData = await ratesRes.json() as any;
      setStatus({ province, provinceCode, existing: ratesData.existingApplication ?? null });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load EHF status.");
    } finally {
      setLoading(false);
    }
  }, [orderId, query]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  if (loading) {
    return (
      <InlineStack gap="small" blockAlignment="center">
        <ProgressIndicator size="small" />
        <Text>Loading EHF…</Text>
      </InlineStack>
    );
  }

  const provinceLabel = status?.provinceCode
    ? `${status.province} (${status.provinceCode})`
    : "No province";
  const isApplied = !!status?.existing;
  const total = status?.existing?.totalAmountCents ?? 0;

  return (
    <BlockStack gap="small">
      <InlineStack gap="small" blockAlignment="center">
        <Text fontWeight="bold">EHF Manager</Text>
        <Badge tone={isApplied ? "success" : "warning"}>
          {isApplied ? "EHF Applied" : "Pending"}
        </Badge>
      </InlineStack>
      <Text>{"Ship-to: " + provinceLabel}</Text>
      {isApplied && (
        <Banner tone="success" title={`${fmt(total)} EHF on order${status?.existing?.appliedBy ? ` · by ${status.existing.appliedBy}` : ""}`} />
      )}
      {errorMsg && <Banner tone="critical" title={errorMsg} />}
    </BlockStack>
  );
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
