/**
 * Caisses maladie dont on sait qu'elles permettent de s'affilier en ligne à
 * l'assurance de base.
 *
 * La liste des assureurs admis de l'OFSP donne l'adresse du site de chaque
 * caisse, mais pas si ce site permet de souscrire : une caisse sans interface
 * de souscription n'en a pas moins un site vitrine. Sans cette distinction,
 * l'application renverrait vers un site où l'assuré ne trouverait aucun
 * formulaire, au lieu de lui préparer la lettre d'affiliation.
 *
 * Les caisses absentes d'ici sont traitées comme ne proposant pas de
 * souscription en ligne : l'assuré reçoit la lettre à envoyer par email ou par
 * la poste, ce qui fonctionne dans tous les cas. Une entrée erronée, elle,
 * enverrait sur une page inutile — d'où une liste courte, à compléter après
 * vérification sur le site de la caisse.
 *
 * `match` est comparé au nom court du catalogue officiel, sans accents, casse
 * ni ponctuation. `url` est la page d'entrée de la souscription ; à défaut,
 * le site publié par l'OFSP est utilisé.
 */
export interface OnlineChannel {
  match: string[];
  url?: string;
}

export const ONLINE_SUBSCRIPTION: OnlineChannel[] = [
  { match: ['css', 'arcosana', 'intras', 'sanagate'], url: 'https://www.css.ch' },
  { match: ['helsana', 'progres', 'avanex'], url: 'https://www.helsana.ch' },
  { match: ['swica'], url: 'https://www.swica.ch' },
  { match: ['sanitas', 'compact'], url: 'https://www.sanitas.com' },
  { match: ['visana', 'vivacare'], url: 'https://www.visana.ch' },
  { match: ['concordia'], url: 'https://www.concordia.ch' },
  { match: ['assura'], url: 'https://www.assura.ch' },
  { match: ['kpt'], url: 'https://www.kpt.ch' },
  { match: ['atupri'], url: 'https://www.atupri.ch' },
  { match: ['okk', 'oekk'], url: 'https://www.oekk.ch' },
  { match: ['sympany', 'vivao', 'moove'], url: 'https://www.sympany.ch' },
  { match: ['egk'], url: 'https://www.egk.ch' },
  { match: ['groupe mutuel', 'mutuel', 'avenir', 'philos', 'easy sana'], url: 'https://www.groupemutuel.ch' },
  { match: ['aquilana'], url: 'https://www.aquilana.ch' }
];

function key(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Canal en ligne connu pour cette caisse, cherché par mot entier dans son nom. */
export function onlineChannelFor(...names: Array<string | undefined>): OnlineChannel | undefined {
  const haystacks = names.filter(Boolean).map((name) => ` ${key(name as string)} `);
  return ONLINE_SUBSCRIPTION.find((channel) =>
    channel.match.some((word) => haystacks.some((h) => h.includes(` ${key(word)} `))));
}
