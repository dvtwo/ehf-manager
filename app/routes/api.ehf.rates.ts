import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// GET /api/ehf/rates?province=ON&orderId=gid%3A...&skus=SKU1,SKU2
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const province = url.searchParams.get("province")?.toUpperCase() ?? "";
  const orderId = url.searchParams.get("orderId") ?? "";
  const skusParam = url.searchParams.get("skus") ?? "";
  const skus = skusParam
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Look up EHF rate for each SKU
  const rates: Record<string, { amountCents: number; categoryName: string | null }> = {};

  await Promise.all(
    skus.map(async (sku) => {
      if (!sku) return;
      const mapping = await prisma.skuCategoryMapping.findUnique({
        where: { sku },
        include: { category: true },
      });

      if (!mapping) {
        rates[sku] = { amountCents: 0, categoryName: null };
        return;
      }

      const rate =
        province
          ? await prisma.ehfRate.findFirst({
              where: { provinceCode: province, categoryId: mapping.categoryId, isActive: true },
            })
          : null;

      rates[sku] = {
        amountCents: rate?.amountCents ?? 0,
        categoryName: mapping.category.name,
      };
    })
  );

  // Check for a prior EHF application on this order
  const existing = orderId
    ? await prisma.ehfApplication.findUnique({
        where: { orderId },
        select: {
          totalAmountCents: true,
          appliedBy: true,
          appliedAt: true,
          lineBreakdown: true,
        },
      })
    : null;

  const allCategories = await prisma.ehfCategory.findMany({
    orderBy: { name: "asc" },
    include: province
      ? { rates: { where: { provinceCode: province, isActive: true } } }
      : { rates: false },
  });

  const categories = allCategories.map((c) => ({
    id: c.id,
    name: c.name,
    rateCents: (c as any).rates?.[0]?.amountCents ?? 0,
  }));

  return json(
    {
      rates,
      categories,
      existingApplication: existing
        ? { ...existing, appliedAt: (existing.appliedAt as Date).toISOString() }
        : null,
    },
    { headers: CORS }
  );
}

// Handle CORS preflight
export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  return json({ error: "Method not allowed." }, { status: 405, headers: CORS });
}
