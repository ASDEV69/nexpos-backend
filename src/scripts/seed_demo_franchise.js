// nexpos-backend-final/src/scripts/seed_demo_franchise.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("--- NEXPOS FRANCHISE DEMO SEED ---");

  // 1. Create a Demo Group
  const group = await prisma.group.upsert({
    where: { slug: 'demo-franchise' },
    update: {},
    create: {
      name: 'Franchise Démo NEXPOS',
      slug: 'demo-franchise',
      logo: 'https://placehold.co/100x100?text=FRANCHISE'
    }
  });
  console.log(`Group created: ${group.id}`);

  // 2. Create 2 Sites
  const sites = [
    { name: 'NEXPOS Paris', city: 'Paris', slug: 'paris', siret: '11122233300018' },
    { name: 'NEXPOS Lyon',  city: 'Lyon',  slug: 'lyon',  siret: '44455566600019' }
  ];

  const estabs = [];
  for (const s of sites) {
    const estab = await prisma.establishment.upsert({
      where: { id: `estab-${s.slug}` },
      update: { group: { connect: { id: group.id } } },
      create: {
        id: `estab-${s.slug}`,
        name: s.name,
        siret: s.siret,
        address: `Rue de ${s.city}`,
        zipCode: '75000',
        city: s.city,
        group: { connect: { id: group.id } }
      }
    });

    // Create a TvaRate for the site (use try/catch or find first since upsert needs unique)
    await prisma.tvaRate.deleteMany({ where: { establishmentId: estab.id } });
    const tva = await prisma.tvaRate.create({
      data: { establishmentId: estab.id, rate: 10, label: 'TVA 10%' }
    });

    await prisma.paymentMode.deleteMany({ where: { establishmentId: estab.id } });
    const pm = await prisma.paymentMode.create({
      data: { establishmentId: estab.id, label: 'CB', active: true }
    });

    estabs.push({ ...estab, tvaId: tva.id, pmId: pm.id });
    console.log(`Establishment created: ${estab.name} (${estab.id})`);
  }

  // 3. Create a Demo User (Franchise Owner)
  // Check if user exists first
  const existingUser = await prisma.user.findFirst({
    where: { email: 'demo@nexpos.fr' }
  });

  let user;
  if (existingUser) {
    user = await prisma.user.update({
      where: { id: existingUser.id },
      data: { role: 'ADMIN', establishmentId: estabs[0].id }
    });
  } else {
    user = await prisma.user.create({
      data: {
        email: 'demo@nexpos.fr',
        name: 'Admin Démo',
        initial: 'AD',
        role: 'ADMIN',
        pin: '1234',
        establishmentId: estabs[0].id
      }
    });
  }
  
  await prisma.groupUser.upsert({
    where: { groupId_userId: { groupId: group.id, userId: user.id } },
    update: { role: 'OWNER' },
    create: { groupId: group.id, userId: user.id, role: 'OWNER' }
  });
  console.log(`User created/updated: demo@nexpos.fr (PIN 1234)`);

  // 4. Inject some sales for today
  const today = new Date();
  
  for (const estab of estabs) {
    console.log(`Injecting sales for ${estab.name}...`);
    // Delete old tickets to avoid growth
    await prisma.ticket.deleteMany({ where: { establishmentId: estab.id } });

    for (let i = 0; i < 5; i++) {
        const amount = 20 + Math.random() * 50;
        await prisma.ticket.create({
            data: {
                establishmentId: estab.id,
                status: 'PAID',
                totalHt: amount / 1.1,
                totalTva: amount - (amount / 1.1),
                finalAmount: amount,
                createdAt: today,
                number: 100 + i,
                lines: { 
                  create: { 
                    label: 'Produit Démo', 
                    qty: 1, 
                    unitPriceHt: amount / 1.1,
                    unitPriceTtc: amount,
                    totalHt: amount/1.1, 
                    totalTva: amount - (amount/1.1), 
                    totalTtc: amount, 
                    tvaRate: 10,
                    tvaRateId: estab.tvaId
                  } 
                },
                payments: { 
                  create: { 
                    amount: amount, 
                    paymentModeId: estab.pmId 
                  } 
                }
            }
        });
    }
  }

  console.log("--- SEED FINISHED ---");
}

main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
