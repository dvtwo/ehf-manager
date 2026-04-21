import prisma from "./db.server";

export interface LineItemInput {
  lineItemId: string;
  title: string;
  sku: string | null;
  quantity: number;
}

export interface LineItemEhfResult {
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

export interface ApplyLineItemInput {
  lineItemId: string;
  title: string;
  sku: string | null;
  chargeEhf: boolean;
  suggestedAmountCents: number;
  appliedAmountCents: number;
  isOverride: boolean;
  overrideReason: string;
}

// Returns the suggested EHF amount (per unit) for a SKU in a given province.
export async function getEhfForSku(
  sku: string | null,
  provinceCode: string
): Promise<{ amountCents: number; categoryName: string | null }> {
  if (!sku) return { amountCents: 0, categoryName: null };

  const mapping = await prisma.skuCategoryMapping.findUnique({
    where: { sku },
    include: { category: true },
  });

  if (!mapping) return { amountCents: 0, categoryName: null };

  const rate = await prisma.ehfRate.findFirst({
    where: {
      provinceCode: provinceCode.toUpperCase(),
      categoryId: mapping.categoryId,
      isActive: true,
    },
  });

  return {
    amountCents: rate?.amountCents ?? 0,
    categoryName: mapping.category.name,
  };
}

// Calculates suggested EHF amounts for all line items on an order.
export async function calculateOrderEhf(
  lineItems: LineItemInput[],
  provinceCode: string
): Promise<LineItemEhfResult[]> {
  return Promise.all(
    lineItems.map(async (item) => {
      const { amountCents, categoryName } = await getEhfForSku(
        item.sku,
        provinceCode
      );
      return {
        lineItemId: item.lineItemId,
        title: item.title,
        sku: item.sku ?? "",
        quantity: item.quantity,
        suggestedAmountCents: amountCents,
        categoryName,
        chargeEhf: amountCents > 0,
        appliedAmountCents: amountCents,
        isOverride: false,
        overrideReason: "",
      };
    })
  );
}

// Saves or updates an EHF application record for an order.
export async function saveEhfApplication({
  orderId,
  orderName,
  shopDomain,
  provinceCode,
  totalAmountCents,
  lineBreakdown,
  shopifyLineItemId,
  appliedBy,
}: {
  orderId: string;
  orderName: string;
  shopDomain: string;
  provinceCode: string;
  totalAmountCents: number;
  lineBreakdown: ApplyLineItemInput[];
  shopifyLineItemId: string | null;
  appliedBy: string | null;
}) {
  const application = await prisma.ehfApplication.upsert({
    where: { orderId },
    update: {
      orderName,
      provinceCode,
      totalAmountCents,
      lineBreakdown,
      shopifyLineItemId,
      appliedBy,
      updatedAt: new Date(),
    },
    create: {
      orderId,
      orderName,
      shopDomain,
      provinceCode,
      totalAmountCents,
      lineBreakdown,
      shopifyLineItemId,
      appliedBy,
    },
  });

  // Write override audit rows for any line items that had overrides or charges.
  for (const item of lineBreakdown) {
    if (!item.chargeEhf) continue;
    await prisma.ehfOverrideLog.create({
      data: {
        applicationId: application.id,
        orderId,
        lineItemId: item.lineItemId,
        sku: item.sku ?? null,
        productTitle: item.title,
        provinceCode,
        calculatedAmountCents: item.suggestedAmountCents,
        appliedAmountCents: item.appliedAmountCents,
        isOverride: item.isOverride,
        overrideReason: item.overrideReason || null,
        staffUser: appliedBy,
      },
    });
  }

  return application;
}

// Formats cents as a CAD dollar string for display.
export function formatCad(cents: number): string {
  return `$${(cents / 100).toFixed(2)} CAD`;
}

// The title used for the combined EHF custom line item on the Shopify order.
export const EHF_LINE_ITEM_TITLE = "Environmental Handling Fee";
