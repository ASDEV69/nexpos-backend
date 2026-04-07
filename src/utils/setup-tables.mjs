// Setup default tables
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function setupTables() {
  const EST = 'a7276c31-81c3-4250-9ba4-ebba8b108e7c'; // établissement de test

  console.log('🪑 Setup Tables & Salles...\n');

  try {
    // Compter les tables existantes
    const existing = await prisma.table.count({
      where: { establishmentId: EST, active: true }
    });

    console.log(`✓ Tables existantes: ${existing}\n`);

    // Définir les salles
    const sections = {
      'Salle principale': [
        { label: 'Table 1', covers: 2, emoji: '🪑' },
        { label: 'Table 2', covers: 4, emoji: '🪑' },
        { label: 'Table 3', covers: 4, emoji: '🪑' },
        { label: 'Table 4', covers: 6, emoji: '🪑' },
        { label: 'Table 5', covers: 2, emoji: '🪑' },
      ],
      'Terrasse': [
        { label: 'Terrasse 1', covers: 4, emoji: '☀️' },
        { label: 'Terrasse 2', covers: 6, emoji: '☀️' },
        { label: 'Terrasse 3', covers: 2, emoji: '☀️' },
      ],
      'Bar': [
        { label: 'Bar Comptoir', covers: 1, emoji: '🍷' },
      ],
    };

    // Créer les tables par section
    for (const [section, tables] of Object.entries(sections)) {
      console.log(`\n── ${section} ──`);

      for (const tableData of tables) {
        // Vérifier si la table existe
        const existing = await prisma.table.findFirst({
          where: {
            establishmentId: EST,
            label: tableData.label,
          }
        });

        if (existing) {
          console.log(`  ✓ Existe déjà: ${tableData.emoji} ${tableData.label} (${tableData.covers} couverts)`);
        } else {
          const created = await prisma.table.create({
            data: {
              establishmentId: EST,
              label: tableData.label,
              section,
              covers: tableData.covers,
              emoji: tableData.emoji,
              status: 'FREE',
              active: true,
            }
          });
          console.log(`  + Créée: ${tableData.emoji} ${created.label} (${created.covers} couverts)`);
        }
      }
    }

    // Récapitulatif
    const total = await prisma.table.count({
      where: { establishmentId: EST, active: true }
    });

    const bySection = await prisma.table.groupBy({
      by: ['section'],
      where: { establishmentId: EST, active: true },
      _count: true,
    });

    console.log('\n═════════════════════════════════\n');
    console.log(`📊 Total tables: ${total}\n`);

    bySection.forEach(group => {
      console.log(`  ${group.section}: ${group._count} tables`);
    });

    console.log('\n✅ Setup terminé');

  } catch (err) {
    console.error('❌ Erreur:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

setupTables();
