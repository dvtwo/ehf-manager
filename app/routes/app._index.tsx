import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
  InlineGrid,
  Badge,
  EmptyState,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [totalApplications, totalOverrides, recentApplications, recentOverrides] =
    await Promise.all([
      prisma.ehfApplication.count(),
      prisma.ehfOverrideLog.count({ where: { isOverride: true } }),
      prisma.ehfApplication.findMany({
        orderBy: { appliedAt: "desc" },
        take: 20,
        select: {
          orderId: true,
          orderName: true,
          provinceCode: true,
          totalAmountCents: true,
          appliedBy: true,
          appliedAt: true,
        },
      }),
      prisma.ehfOverrideLog.findMany({
        where: { isOverride: true },
        orderBy: { appliedAt: "desc" },
        take: 10,
        select: {
          orderId: true,
          sku: true,
          productTitle: true,
          provinceCode: true,
          calculatedAmountCents: true,
          appliedAmountCents: true,
          overrideReason: true,
          staffUser: true,
          appliedAt: true,
        },
      }),
    ]);

  return json({
    stats: { totalApplications, totalOverrides },
    recentApplications: recentApplications.map((a) => ({
      ...a,
      appliedAt: a.appliedAt.toISOString(),
    })),
    recentOverrides: recentOverrides.map((o) => ({
      ...o,
      appliedAt: o.appliedAt.toISOString(),
    })),
  });
};

function cents(n: number) {
  return `$${(n / 100).toFixed(2)}`;
}

export default function Dashboard() {
  const { stats, recentApplications, recentOverrides } =
    useLoaderData<typeof loader>();

  return (
    <Page title="EHF Manager — Dashboard">
      <BlockStack gap="500">
        <InlineGrid columns={2} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Orders with EHF Applied
              </Text>
              <Text variant="heading2xl" as="p">
                {stats.totalApplications}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Manual Overrides
              </Text>
              <Text variant="heading2xl" as="p">
                {stats.totalOverrides}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              Recent EHF Applications
            </Text>
            {recentApplications.length === 0 ? (
              <EmptyState
                heading="No EHF applications yet"
                image=""
              >
                <p>
                  Open an order in Shopify admin and use the EHF Manager block to
                  apply fees.
                </p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Order", "Province", "Total EHF", "Applied By", "Date"]}
                rows={recentApplications.map((a) => [
                  a.orderName ?? a.orderId,
                  a.provinceCode,
                  cents(a.totalAmountCents),
                  a.appliedBy ?? "—",
                  new Date(a.appliedAt).toLocaleDateString("en-CA"),
                ])}
              />
            )}
          </BlockStack>
        </Card>

        {recentOverrides.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Recent Manual Overrides
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                headings={["Order", "SKU", "Province", "Calculated", "Applied", "Reason"]}
                rows={recentOverrides.map((o) => [
                  o.orderId,
                  o.sku ?? "—",
                  o.provinceCode,
                  cents(o.calculatedAmountCents),
                  <Box key={o.orderId + o.sku}>
                    <Badge tone="warning">{cents(o.appliedAmountCents)}</Badge>
                  </Box>,
                  o.overrideReason ?? "—",
                ])}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
