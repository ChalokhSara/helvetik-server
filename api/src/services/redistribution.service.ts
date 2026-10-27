import { Premium, PremiumInsurer, PremiumRegion, PremiumYear } from '../models/premium.model';
import { fetchText, resolveInsurer, resolveLocation } from './priminfo.service';
import { parsePremiums } from './priminfo-premiums';

/**
 * Redistribution annuelle par assuré, telle que priminfo la déduit des primes.
 *
 * Elle n'est dans aucun des fichiers de l'OFSP et change chaque année : taxe
 * sur le CO2, taxe sur les COV, et parfois une compensation versée par
 * certaines caisses après une réduction de leurs réserves. Une valeur figée
 * fausse donc toutes les primes affichées d'autant — 40 centimes par mois en
 * 2027, où elle est passée de 61.80 à 57.00 francs par an.
 *
 * On la mesure là où elle est appliquée : priminfo affiche, pour chaque offre,
 * la prime brute, la redistribution et le total. Un adulte, une franchise,
 * la première région connue suffisent : le montant est le même pour tous les
 * adultes. Avant de s'y fier, on vérifie que priminfo montre bien l'année
 * importée, en recoupant ses primes brutes avec les nôtres.
 */
export async function measureRedistributionYearly(year: number): Promise<number | null> {
  const region = await PremiumRegion.findOne({ year });
  if (!region) {
    return null;
  }

  const location = await resolveLocation(region.plz, region.locality);
  if (!location.match) {
    return null;
  }

  // La vue détaillée exige une caisse « actuelle » : n'importe laquelle convient.
  const reference = await Premium.findOne({
    year, canton: region.canton, region: region.region, ageClass: 'ERW', franchise: 300,
    withAccident: true, tariffType: 'BASE'
  });
  const insurer = reference ? await PremiumInsurer.findOne({ year, insurerId: reference.insurerId }) : null;
  const priminfoInsurer = insurer ? await resolveInsurer(insurer.name, location.match.id) : null;
  if (!reference || !priminfoInsurer?.match) {
    return null;
  }

  const params = new URLSearchParams({
    location_id: location.match.id,
    insurer: priminfoInsurer.match.id,
    'yob[0]': '1990',
    'franchise[0]': '300',
    'coverage[0]': '1',
    plan: 'BASE',
    display: 'savings'
  });
  params.append('models[]', 'BASE');

  const offers = parsePremiums(await fetchText(`https://www.priminfo.admin.ch/fr/praemien?${params}`)).offers;

  // Même année que nos données : la prime brute de la caisse de référence
  // doit figurer telle quelle parmi celles de priminfo.
  if (!offers.some((offer) => offer.monthly.premium === reference.premium)) {
    console.warn(`[primes] priminfo ne montre pas les primes ${year} : redistribution non mesurée.`);
    return null;
  }

  const monthly = offers
    .map((offer) => offer.monthly.redistribution)
    .filter((value): value is number => value !== null && value > 0)
    .sort((a, b) => a - b);
  if (!monthly.length) {
    return null;
  }

  // La médiane écarte une éventuelle caisse qui reverse davantage (réduction de réserves).
  const median = monthly[Math.floor(monthly.length / 2)];
  return Math.round(median * 12 * 100) / 100;
}

/** Mesure et enregistre la redistribution d'une année ; renvoie un message pour le rapport. */
export async function updateRedistribution(year: number): Promise<string | null> {
  try {
    const yearly = await measureRedistributionYearly(year);
    if (yearly === null) {
      return null;
    }
    await PremiumYear.updateOne({ year }, { $set: { redistributionYearly: yearly } });
    return `Redistribution ${year} lue sur priminfo : ${yearly.toFixed(2)} CHF/an ` +
      `(${(yearly / 12).toFixed(2)}/mois).`;
  } catch (err) {
    console.error('[primes] redistribution non mesurée :', (err as Error).message);
    return null;
  }
}
