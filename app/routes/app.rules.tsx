import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  BlockStack,
  Button,
  TextField,
  Select,
  Banner,
  InlineStack,
  Divider,
  Badge,
  EmptyState,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [categories, rates, skuMappings] = await Promise.all([
    prisma.ehfCategory.findMany({ orderBy: { name: "asc" } }),
    prisma.ehfRate.findMany({
      orderBy: [{ provinceCode: "asc" }, { categoryId: "asc" }],
      include: { category: true },
    }),
    prisma.skuCategoryMapping.findMany({
      orderBy: { sku: "asc" },
      include: { category: true },
    }),
  ]);

  return json({ categories, rates, skuMappings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent") as string;

  try {
    if (intent === "add-sku-mapping") {
      const sku = (form.get("sku") as string)?.trim().toUpperCase();
      const categoryId = parseInt(form.get("categoryId") as string, 10);
      if (!sku || !categoryId) throw new Error("SKU and category are required.");
      await prisma.skuCategoryMapping.upsert({
        where: { sku },
        update: { categoryId },
        create: { sku, categoryId },
      });
      return json({ success: `SKU ${sku} mapped.` });
    }

    if (intent === "delete-sku-mapping") {
      const sku = form.get("sku") as string;
      await prisma.skuCategoryMapping.delete({ where: { sku } });
      return json({ success: `SKU ${sku} removed.` });
    }

    if (intent === "add-rate") {
      const provinceCode = (form.get("provinceCode") as string)?.trim().toUpperCase();
      const provinceName = (form.get("provinceName") as string)?.trim();
      const categoryId = parseInt(form.get("categoryId") as string, 10);
      const amountCents = Math.round(parseFloat(form.get("amount") as string) * 100);
      if (!provinceCode || !categoryId) throw new Error("Province and category are required.");
      if (isNaN(amountCents) || amountCents < 0) throw new Error("Invalid amount.");
      await prisma.ehfRate.upsert({
        where: { provinceCode_categoryId: { provinceCode, categoryId } },
        update: { amountCents, provinceName, isActive: true },
        create: { provinceCode, provinceName, categoryId, amountCents, isActive: true },
      });
      return json({ success: `Rate added for ${provinceName} (${provinceCode}).` });
    }

    if (intent === "update-rate") {
      const id = parseInt(form.get("id") as string, 10);
      const amountCents = Math.round(
        parseFloat(form.get("amount") as string) * 100
      );
      if (isNaN(amountCents) || amountCents < 0)
        throw new Error("Invalid amount.");
      await prisma.ehfRate.update({
        where: { id },
        data: { amountCents },
      });
      return json({ success: "Rate updated." });
    }

    if (intent === "delete-rate") {
      const id = parseInt(form.get("id") as string, 10);
      await prisma.ehfRate.delete({ where: { id } });
      return json({ success: "Rate removed." });
    }

    if (intent === "add-category") {
      const name = (form.get("name") as string)?.trim();
      const description = (form.get("description") as string)?.trim() || null;
      if (!name) throw new Error("Category name is required.");
      await prisma.ehfCategory.create({ data: { name, description } });
      return json({ success: `Category "${name}" created.` });
    }

    if (intent === "delete-category") {
      const id = parseInt(form.get("id") as string, 10);
      await prisma.ehfCategory.delete({ where: { id } });
      return json({ success: "Category deleted." });
    }

    return json({ error: "Unknown intent." }, { status: 400 });
  } catch (e: unknown) {
    return json({ error: (e as Error).message }, { status: 422 });
  }
};

const PROVINCES = [
  { code: "AB", name: "Alberta" },
  { code: "BC", name: "British Columbia" },
  { code: "MB", name: "Manitoba" },
  { code: "NB", name: "New Brunswick" },
  { code: "NL", name: "Newfoundland and Labrador" },
  { code: "NS", name: "Nova Scotia" },
  { code: "NT", name: "Northwest Territories" },
  { code: "NU", name: "Nunavut" },
  { code: "ON", name: "Ontario" },
  { code: "PE", name: "Prince Edward Island" },
  { code: "QC", name: "Quebec" },
  { code: "SK", name: "Saskatchewan" },
  { code: "YT", name: "Yukon" },
];

function cents(n: number) {
  return (n / 100).toFixed(2);
}

export default function RulesPage() {
  const { categories, rates, skuMappings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();

  // SKU mapping form
  const [newSku, setNewSku] = useState("");
  const [newCategoryId, setNewCategoryId] = useState("");

  // Category form
  const [newCatName, setNewCatName] = useState("");
  const [newCatDesc, setNewCatDesc] = useState("");

  // Add rate form
  const [newProvinceCode, setNewProvinceCode] = useState("");
  const [newRateCategoryId, setNewRateCategoryId] = useState("");
  const [newRateAmount, setNewRateAmount] = useState("");

  // Rate editing
  const [editingRateId, setEditingRateId] = useState<number | null>(null);
  const [editingRateAmount, setEditingRateAmount] = useState("");

  const categoryOptions = categories.map((c) => ({
    label: c.name,
    value: String(c.id),
  }));

  const handleAddSku = useCallback(() => {
    if (!newSku || !newCategoryId) return;
    submit(
      { intent: "add-sku-mapping", sku: newSku, categoryId: newCategoryId },
      { method: "post" }
    );
    setNewSku("");
    setNewCategoryId("");
  }, [newSku, newCategoryId, submit]);

  const handleDeleteSku = useCallback(
    (sku: string) => {
      if (!confirm(`Remove SKU mapping for ${sku}?`)) return;
      submit({ intent: "delete-sku-mapping", sku }, { method: "post" });
    },
    [submit]
  );

  const handleUpdateRate = useCallback(
    (id: number) => {
      submit(
        { intent: "update-rate", id: String(id), amount: editingRateAmount },
        { method: "post" }
      );
      setEditingRateId(null);
      setEditingRateAmount("");
    },
    [editingRateAmount, submit]
  );

  const handleAddRate = useCallback(() => {
    if (!newProvinceCode || !newRateCategoryId || !newRateAmount) return;
    const province = PROVINCES.find((p) => p.code === newProvinceCode);
    submit(
      {
        intent: "add-rate",
        provinceCode: newProvinceCode,
        provinceName: province?.name ?? newProvinceCode,
        categoryId: newRateCategoryId,
        amount: newRateAmount,
      },
      { method: "post" }
    );
    setNewRateAmount("");
  }, [newProvinceCode, newRateCategoryId, newRateAmount, submit]);

  const handleDeleteRate = useCallback(
    (id: number) => {
      if (!confirm("Remove this rate?")) return;
      submit({ intent: "delete-rate", id: String(id) }, { method: "post" });
    },
    [submit]
  );

  const handleDeleteCategory = useCallback(
    (id: number, name: string) => {
      if (!confirm(`Delete category "${name}"? This will also remove all province rates for this category.`)) return;
      submit({ intent: "delete-category", id: String(id) }, { method: "post" });
    },
    [submit]
  );

  const handleAddCategory = useCallback(() => {
    if (!newCatName) return;
    submit(
      { intent: "add-category", name: newCatName, description: newCatDesc },
      { method: "post" }
    );
    setNewCatName("");
    setNewCatDesc("");
  }, [newCatName, newCatDesc, submit]);

  const success = actionData && "success" in actionData ? actionData.success : null;
  const error = actionData && "error" in actionData ? actionData.error : null;

  return (
    <Page
      title="EHF Rules"
      subtitle="Manage province rates, product categories, and SKU mappings"
    >
      <BlockStack gap="600">
        {success && <Banner tone="success"><p>{success}</p></Banner>}
        {error && <Banner tone="critical"><p>{error}</p></Banner>}

        {/* SKU Mappings */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">SKU → Category Mappings</Text>
            <Text tone="subdued" as="p">
              Map product SKUs to EHF categories so the app can look up the
              correct fee. SKUs are stored in uppercase.
            </Text>

            <InlineStack gap="300" blockAlignment="end">
              <div style={{ flex: 1 }}>
                <TextField
                  label="SKU"
                  value={newSku}
                  onChange={setNewSku}
                  autoComplete="off"
                  placeholder="e.g. T49-LAPTOP-001"
                />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="Category"
                  options={[{ label: "Select category…", value: "" }, ...categoryOptions]}
                  value={newCategoryId}
                  onChange={setNewCategoryId}
                />
              </div>
              <Button variant="primary" onClick={handleAddSku}>
                Add / Update
              </Button>
            </InlineStack>

            <Divider />

            {skuMappings.length === 0 ? (
              <EmptyState heading="No SKU mappings yet" image="">
                <p>Add SKUs above to enable automatic EHF calculation.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["SKU", "Category", "Actions"]}
                rows={skuMappings.map((m) => [
                  <Text variant="bodyMd" as="span" fontWeight="semibold" key={m.sku}>
                    {m.sku}
                  </Text>,
                  m.category.name,
                  <Button
                    key={m.sku + "-del"}
                    variant="plain"
                    tone="critical"
                    onClick={() => handleDeleteSku(m.sku)}
                  >
                    Remove
                  </Button>,
                ])}
              />
            )}
          </BlockStack>
        </Card>

        {/* Province Rates */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">Province EHF Rates</Text>
            <Text tone="subdued" as="p">
              Amounts are in CAD. Click Edit to change a rate. Provinces without
              a rate configured will return $0.00 (no EHF charged).
            </Text>

            <InlineStack gap="300" blockAlignment="end">
              <div style={{ flex: 1 }}>
                <Select
                  label="Province"
                  options={[
                    { label: "Select province…", value: "" },
                    ...PROVINCES.map((p) => ({ label: `${p.name} (${p.code})`, value: p.code })),
                  ]}
                  value={newProvinceCode}
                  onChange={setNewProvinceCode}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="Category"
                  options={[{ label: "Select category…", value: "" }, ...categoryOptions]}
                  value={newRateCategoryId}
                  onChange={setNewRateCategoryId}
                />
              </div>
              <div style={{ width: 120 }}>
                <TextField
                  label="Amount (CAD)"
                  value={newRateAmount}
                  onChange={setNewRateAmount}
                  prefix="$"
                  autoComplete="off"
                  placeholder="0.00"
                />
              </div>
              <Button variant="primary" onClick={handleAddRate}>
                Add Rate
              </Button>
            </InlineStack>

            <Divider />

            {rates.length === 0 ? (
              <EmptyState heading="No rates configured yet" image="">
                <p>Add province/category rates above to enable EHF calculation.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Province", "Category", "Amount (CAD)", "Active", "Actions"]}
                rows={rates.map((r) => [
                  `${r.provinceName} (${r.provinceCode})`,
                  r.category.name,
                  editingRateId === r.id ? (
                    <InlineStack gap="200" key={r.id}>
                      <div style={{ width: 80 }}>
                        <TextField
                          label=""
                          value={editingRateAmount}
                          onChange={setEditingRateAmount}
                          prefix="$"
                          autoComplete="off"
                          autoFocus
                        />
                      </div>
                      <Button size="slim" onClick={() => handleUpdateRate(r.id)}>Save</Button>
                      <Button size="slim" variant="plain" onClick={() => setEditingRateId(null)}>Cancel</Button>
                    </InlineStack>
                  ) : (
                    `$${cents(r.amountCents)}`
                  ),
                  r.isActive ? (
                    <Badge tone="success" key={r.id + "a"}>Active</Badge>
                  ) : (
                    <Badge key={r.id + "i"}>Inactive</Badge>
                  ),
                  <InlineStack gap="200" key={r.id + "-actions"}>
                    {editingRateId !== r.id && (
                      <Button
                        size="slim"
                        variant="plain"
                        onClick={() => {
                          setEditingRateId(r.id);
                          setEditingRateAmount(cents(r.amountCents));
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      size="slim"
                      variant="plain"
                      tone="critical"
                      onClick={() => handleDeleteRate(r.id)}
                    >
                      Remove
                    </Button>
                  </InlineStack>,
                ])}
              />
            )}
          </BlockStack>
        </Card>

        {/* Categories */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">Product Categories</Text>
            <Text tone="subdued" as="p">
              EHF categories group products for fee calculation. Each category
              can have a different rate per province.
            </Text>

            <InlineStack gap="300" blockAlignment="end">
              <div style={{ flex: 1 }}>
                <TextField
                  label="Category name"
                  value={newCatName}
                  onChange={setNewCatName}
                  autoComplete="off"
                  placeholder="e.g. Gaming Console"
                />
              </div>
              <div style={{ flex: 2 }}>
                <TextField
                  label="Description (optional)"
                  value={newCatDesc}
                  onChange={setNewCatDesc}
                  autoComplete="off"
                />
              </div>
              <Button variant="primary" onClick={handleAddCategory}>
                Add Category
              </Button>
            </InlineStack>

            <Divider />

            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Category", "Description", "Actions"]}
              rows={categories.map((c) => [
                c.name,
                c.description ?? "—",
                <Button
                  key={c.id}
                  size="slim"
                  variant="plain"
                  tone="critical"
                  onClick={() => handleDeleteCategory(c.id, c.name)}
                >
                  Delete
                </Button>,
              ])}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
