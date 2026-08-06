/**
 * Page de gestion des données officielles de primes (md_premium_*).
 */

import { IPremiumYear, SourceKind } from '../models/premium.model';
import { alertBlock, consolePage, csrfField, escapeHtml, formatDate } from './layout';

const SOURCE_LABELS: Record<SourceKind, string> = {
  PREMIUMS: 'Répertoire des primes',
  REGIONS: 'Régions de primes',
  INSURERS: 'Assureurs admis'
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Préparée',
  ACTIVE: 'En service',
  ARCHIVED: 'Archivée'
};

function statusChip(status: string): string {
  const kind = status === 'ACTIVE' ? 'ok' : status === 'ARCHIVED' ? 'blocked' : '';
  return `<span class="badge ${kind}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} Mo`
    : `${Math.round(bytes / 1024)} Ko`;
}

export interface PremiumsPageOptions {
  username: string;
  years: IPremiumYear[];
  csrf: string;
  error?: string;
  notice?: string;
}

function renderYear(year: IPremiumYear, csrf: string): string {
  const complete = year.premiumRows > 0 && year.regionRows > 0;
  const uid = escapeHtml(String(year.year));

  const sources = (['PREMIUMS', 'REGIONS', 'INSURERS'] as SourceKind[]).map((kind) => {
    const source = year.sources.find((s) => s.kind === kind);
    if (!source) {
      return `        <tr>
          <td>${escapeHtml(SOURCE_LABELS[kind])}</td>
          <td colspan="4"><span class="muted">absent</span></td>
        </tr>`;
    }
    return `        <tr>
          <td>${escapeHtml(SOURCE_LABELS[kind])}</td>
          <td>${escapeHtml(source.filename)}</td>
          <td>${source.rows.toLocaleString('fr-CH')} lignes</td>
          <td>${formatSize(source.size)} · ${source.origin === 'DOWNLOAD' ? 'téléchargé' : 'déposé'}</td>
          <td>${formatDate(source.importedAt)}${source.importedBy ? ` · ${escapeHtml(source.importedBy)}` : ''}</td>
        </tr>`;
  }).join('\n');

  const actions: string[] = [];
  if (year.status !== 'ACTIVE' && complete) {
    actions.push(`          <form method="post" action="/admin/premiums/${uid}/activate" style="display:inline"
                data-confirm="Mettre l'année ${uid} en service ? L'année active sera archivée.">
            ${csrfField(csrf)}
            <button type="submit">Mettre en service</button>
          </form>`);
  }
  if (year.status !== 'ACTIVE') {
    actions.push(`          <form method="post" action="/admin/premiums/${uid}/delete" style="display:inline"
                data-confirm="Supprimer définitivement toutes les données ${uid} ?">
            ${csrfField(csrf)}
            <button type="submit" class="danger">Supprimer</button>
          </form>`);
  }

  const incomplete = complete
    ? ''
    : '      <p class="muted">Import incomplet : le répertoire des primes et les régions sont tous deux nécessaires avant la mise en service.</p>\n';

  return `    <div class="panel" style="max-width:none;margin-bottom:1.5rem">
      <h2 style="margin:0 0 .75rem;font-size:1.1rem">Année ${uid} ${statusChip(year.status)}</h2>
      <p class="muted">
        ${year.premiumRows.toLocaleString('fr-CH')} primes · ${year.regionRows.toLocaleString('fr-CH')} NPA ·
        ${year.insurerRows} assureurs · redistribution ${year.redistributionYearly.toFixed(2)} CHF/an
        (${(year.redistributionYearly / 12).toFixed(2)}/mois) par assuré
        ${year.activatedAt ? `· en service depuis le ${formatDate(year.activatedAt)}` : ''}
      </p>
${incomplete}      <table>
        <thead><tr><th>Source</th><th>Fichier</th><th>Volume</th><th>Taille</th><th>Import</th></tr></thead>
        <tbody>
${sources}
        </tbody>
      </table>
      <div class="form-actions">
        <form method="post" action="/admin/premiums/${uid}/redistribution" style="display:flex;gap:.5rem;align-items:center">
          ${csrfField(csrf)}
          <label for="r-${uid}" style="margin:0">Redistribution CHF/an</label>
          <input id="r-${uid}" name="redistributionYearly" type="number" step="0.05" min="0"
                 value="${year.redistributionYearly}" style="margin:0;width:8rem">
          <button type="submit">Enregistrer</button>
        </form>
${actions.join('\n')}
      </div>
    </div>`;
}

export function renderPremiumsPage(options: PremiumsPageOptions): string {
  const years = options.years.length
    ? options.years.map((y) => renderYear(y, options.csrf)).join('\n')
    : '    <p class="empty">Aucune donnée de primes importée.</p>';

  return consolePage('Helvetik — Primes officielles',
    { username: options.username, active: 'premiums' },
    `    <h1>Primes officielles</h1>
${alertBlock(options.error, options.notice)}

    <div class="panel" style="max-width:none;margin-bottom:1.5rem">
      <h2 style="margin:0 0 .5rem;font-size:1.1rem">Mettre à jour les données</h2>
      <p class="muted">
        Trois fichiers publiés chaque année par l'OFSP : le répertoire complet des primes
        (<code>gesamtbericht_ch.xlsx</code>), les régions de primes
        (<code>praemienregionen.xlsx</code>) et la liste des assureurs admis. Ils se déposent
        un par un, dans n'importe quel ordre : chacun est reconnu à sa structure.
      </p>

      <form method="post" action="/admin/premiums/upload" enctype="multipart/form-data">
        ${csrfField(options.csrf)}
        <label for="file">Fichier Excel de l'OFSP</label>
        <input id="file" name="file" type="file" accept=".xlsx" required>
        <label for="replaceActive" style="font-weight:400">
          <input id="replaceActive" name="replaceActive" type="checkbox" value="true" style="width:auto;margin:0 .4rem 0 0">
          Autoriser le remplacement d'une année déjà en service
        </label>
        <div class="form-actions">
          <button type="submit">Importer le fichier</button>
        </div>
      </form>

      <hr style="margin:1.5rem 0;border:0;border-top:1px solid #e5e7eb">

      <h2 style="margin:0 0 .5rem;font-size:1.1rem">Ou télécharger depuis l'OFSP</h2>
      <p class="muted">
        Récupère les trois fichiers directement sur priminfo.admin.ch. Un fichier dont
        l'empreinte est déjà connue n'est pas réimporté. L'import se fait en état
        « préparée » : il reste à le mettre en service après vérification.
      </p>
      <form method="post" action="/admin/premiums/sync"
            data-confirm="Télécharger les fichiers de l'OFSP et les importer ? L'opération peut prendre une à deux minutes.">
        ${csrfField(options.csrf)}
        <div class="form-actions">
          <button type="submit">Télécharger et importer</button>
        </div>
      </form>
    </div>

${years}`);
}
