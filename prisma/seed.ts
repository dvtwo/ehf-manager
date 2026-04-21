import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Approximate Canadian EHF rates (cents CAD). Update to match current EPRA/ARMA published rates.
const CATEGORIES = [
  { name: "Laptop / Desktop Computer", description: "Portable and desktop computers, workstations" },
  { name: "Monitor / Display", description: "Flat-panel monitors, desktop displays" },
  { name: "Printer / Copier", description: "Inkjet, laser, and multifunction printers" },
  { name: "Television", description: "LCD, LED, OLED televisions" },
  { name: "Smartphone / Tablet", description: "Mobile phones, tablets, e-readers" },
  { name: "Audio Equipment", description: "Speakers, headphones, receivers, soundbars" },
  { name: "Other Electronics", description: "Electronics not otherwise categorized" },
];

// Provinces with formal EHF/recycling programs. Rates are in cents CAD.
// Source: EPRA Canada, ARMA Alberta — verify current rates before going live.
const PROVINCE_RATES: Record<
  string,
  { name: string; rates: Record<string, number> }
> = {
  AB: {
    name: "Alberta",
    rates: {
      "Laptop / Desktop Computer": 450,
      "Monitor / Display": 700,
      "Printer / Copier": 300,
      "Television": 700,
      "Smartphone / Tablet": 100,
      "Audio Equipment": 100,
      "Other Electronics": 100,
    },
  },
  BC: {
    name: "British Columbia",
    rates: {
      "Laptop / Desktop Computer": 475,
      "Monitor / Display": 550,
      "Printer / Copier": 250,
      "Television": 550,
      "Smartphone / Tablet": 75,
      "Audio Equipment": 75,
      "Other Electronics": 75,
    },
  },
  MB: {
    name: "Manitoba",
    rates: {
      "Laptop / Desktop Computer": 150,
      "Monitor / Display": 300,
      "Printer / Copier": 150,
      "Television": 300,
      "Smartphone / Tablet": 50,
      "Audio Equipment": 50,
      "Other Electronics": 50,
    },
  },
  NB: {
    name: "New Brunswick",
    rates: {
      "Laptop / Desktop Computer": 225,
      "Monitor / Display": 400,
      "Printer / Copier": 200,
      "Television": 400,
      "Smartphone / Tablet": 75,
      "Audio Equipment": 75,
      "Other Electronics": 75,
    },
  },
  ON: {
    name: "Ontario",
    rates: {
      "Laptop / Desktop Computer": 350,
      "Monitor / Display": 600,
      "Printer / Copier": 250,
      "Television": 600,
      "Smartphone / Tablet": 75,
      "Audio Equipment": 100,
      "Other Electronics": 100,
    },
  },
  PE: {
    name: "Prince Edward Island",
    rates: {
      "Laptop / Desktop Computer": 200,
      "Monitor / Display": 350,
      "Printer / Copier": 150,
      "Television": 350,
      "Smartphone / Tablet": 50,
      "Audio Equipment": 50,
      "Other Electronics": 50,
    },
  },
  SK: {
    name: "Saskatchewan",
    rates: {
      "Laptop / Desktop Computer": 200,
      "Monitor / Display": 350,
      "Printer / Copier": 150,
      "Television": 350,
      "Smartphone / Tablet": 50,
      "Audio Equipment": 50,
      "Other Electronics": 50,
    },
  },
};

async function main() {
  console.log("Seeding EHF categories...");
  for (const cat of CATEGORIES) {
    await prisma.ehfCategory.upsert({
      where: { name: cat.name },
      update: { description: cat.description },
      create: cat,
    });
  }

  console.log("Seeding province rates...");
  for (const [provinceCode, province] of Object.entries(PROVINCE_RATES)) {
    for (const [categoryName, amountCents] of Object.entries(province.rates)) {
      const category = await prisma.ehfCategory.findUnique({
        where: { name: categoryName },
      });
      if (!category) continue;

      await prisma.ehfRate.upsert({
        where: {
          provinceCode_categoryId: {
            provinceCode,
            categoryId: category.id,
          },
        },
        update: { amountCents, provinceName: province.name, isActive: true },
        create: {
          provinceCode,
          provinceName: province.name,
          categoryId: category.id,
          amountCents,
          isActive: true,
        },
      });
    }
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
