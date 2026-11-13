import { createHash } from 'node:crypto';
import { ImportRow } from './excel-import';

export interface CatalogItem { id: string; version: number; archived_at: string | null; [key: string]: unknown }
export interface ImportCatalog {
  organizations: CatalogItem[]; dataCenters: CatalogItem[]; applications: CatalogItem[];
  servers: CatalogItem[]; domains: CatalogItem[];
}
export function planRows(rows: ImportRow[], catalog: ImportCatalog) {
  const seen = new Map<string, { rowNumber: number; signature: string }>();
  return rows.map((row) => {
    const d = row.data;
    const organization = catalog.organizations.find((item) => item.code === d.organizationCode);
    const dataCenter = catalog.dataCenters.find((item) => item.code === d.dataCenterCode);
    const appMatches = catalog.applications.filter((item) => item.code === d.applicationCode ||
      (item.organization_id === organization?.id && String(item.name).toLowerCase() === d.applicationName?.toLowerCase()));
    const serverMatches = catalog.servers.filter((item) => item.code === d.serverCode ||
      (item.addresses as { address: string; scope: string; kind: string }[]).some((address) =>
        address.kind === 'private' && address.address === d.privateIp && address.scope === d.networkScope));
    const domain = catalog.domains.find((item) => item.name === d.domain);
    const application = appMatches.find((item) => item.code === d.applicationCode);
    const server = serverMatches.length === 1 ? serverMatches[0] : undefined;
    const reasons: string[] = [];
    const errors = [...row.errors];
    if (!organization || organization.archived_at) reasons.push('Unknown or archived organizationCode.');
    if (!dataCenter || dataCenter.archived_at) reasons.push('Unknown or archived dataCenterCode.');
    if (appMatches.some((item) => item.archived_at) || serverMatches.some((item) => item.archived_at) || domain?.archived_at) reasons.push('A matching record is archived.');
    if (!application && appMatches.length) reasons.push('Application name matches another code; review the source code before merging.');
    if (serverMatches.length > 1) reasons.push('Server code and scoped IP identify different servers.');
    const withinBatch: { rowNumber: number; reason: string }[] = [];
    for (const [key, signature] of [
      [`app:${d.applicationCode}`, JSON.stringify([d.applicationName, d.organizationCode, d.serviceType])],
      [`server:${server?.id ?? d.serverCode}`, JSON.stringify([d.hostname, d.dataCenterCode, d.privateIp, d.networkScope])],
      [`ip:${d.networkScope}:${d.privateIp}`, JSON.stringify([d.serverCode, d.hostname, d.dataCenterCode])],
      [`domain:${d.domain}`, JSON.stringify(d.renewalDate ?? null)],
    ]) {
      const previous = seen.get(key);
      if (previous && previous.signature !== signature) {
        reasons.push(`Conflicting values within this workbook (row ${previous.rowNumber}).`);
        withinBatch.push({ rowNumber: previous.rowNumber, reason: key });
      } else if (!previous) seen.set(key, { rowNumber: row.rowNumber, signature });
    }
    const exactKey = `row:${JSON.stringify(d)}`;
    const previous = seen.get(exactKey);
    if (!previous) seen.set(exactKey, { rowNumber: row.rowNumber, signature: '' });
    if (application) reasons.push('Application code already exists.');
    if (server) reasons.push(server.code === d.serverCode ? 'Server code already exists.' : 'Private IP and network scope match an existing server; merge preserves its code.');
    if (domain) reasons.push('Domain already exists.');
    const conflict = !organization || !!organization.archived_at || !dataCenter || !!dataCenter.archived_at ||
      appMatches.some((item) => !!item.archived_at) || serverMatches.some((item) => !!item.archived_at) || !!domain?.archived_at ||
      (!application && appMatches.length > 0) || serverMatches.length > 1 || withinBatch.length > 0;
    const status = errors.length ? 'error' : conflict ? 'conflict' : previous ? 'duplicate' : application || server || domain ? 'match' : 'new';
    // Relevant values and versions protect the preview against changed references and newly appearing matches.
    const snapshot = createHash('sha256').update(JSON.stringify({ organization, dataCenter, appMatches, serverMatches, domain })).digest('hex');
    return { ...row, errors, status, reasons, duplicateOf: previous?.rowNumber ?? null,
      matches: { organization: organization ?? null, dataCenter: dataCenter ?? null, applications: appMatches, servers: serverMatches, domain: domain ?? null },
      targets: { organizationId: organization?.id, dataCenterId: dataCenter?.id, applicationId: application?.id, serverId: server?.id, domainId: domain?.id },
      snapshot, decision: status === 'new' ? 'create' : 'skip' };
  });
}
export type PlannedRow = ReturnType<typeof planRows>[number];
