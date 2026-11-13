import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Actor, requireAdmin, SessionRequest } from './access';
import { recordAudit } from './audit.service';
import { Database } from './database';
import { normalizeSheet, parseWorkbook, SheetData } from './excel-import';
import { CatalogItem, ImportCatalog, PlannedRow, planRows } from './import-plan';
import { ApiError, bodyOf, choice, invalid, missing, requestId, stale, text, uuid, version } from '../shared/api-contract';

interface Batch { id: string; created_by: string; file_name: string; status: string; preview_version: number;
  workbook: SheetData[]; mapping: Record<string, unknown>; result: unknown }
type UploadRequest = SessionRequest & AsyncIterable<Buffer> & { body?: unknown };

async function catalog(client: PoolClient): Promise<ImportCatalog> {
  const organizations = (await client.query<CatalogItem>('SELECT id, code, name, version, archived_at FROM lcit.organizations ORDER BY id')).rows;
  const dataCenters = (await client.query<CatalogItem>('SELECT id, code, name, version, archived_at FROM lcit.data_centers ORDER BY id')).rows;
  const applications = (await client.query<CatalogItem>('SELECT id, code, name, organization_id, service_type, version, archived_at FROM lcit.applications ORDER BY id')).rows;
  const servers = (await client.query<CatalogItem>(`SELECT s.id, s.code, s.hostname, s.data_center_id, s.version, s.archived_at,
    COALESCE((SELECT json_agg(json_build_object('address', host(a.address), 'scope', a.network_scope, 'kind', a.kind) ORDER BY a.id)
      FROM lcit.server_addresses a WHERE a.server_id = s.id), '[]') AS addresses FROM lcit.servers s ORDER BY s.id`)).rows;
  const domains = (await client.query<CatalogItem>('SELECT id, name, renewal_date::text, version, archived_at FROM lcit.domains ORDER BY id')).rows;
  return { organizations, dataCenters, applications, servers, domains };
}

async function batchOf(client: PoolClient, id: string, actor: Actor, lock = false) {
  const { rows: [batch] } = await client.query<Batch>(`SELECT * FROM lcit.import_batches WHERE id=$1 AND created_by=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, actor.id]);
  if (!batch) missing();
  return batch;
}

@Injectable()
export class ImportsService {
  constructor(private readonly db: Database) {}

  async upload(request: SessionRequest, rawName: unknown) {
    requireAdmin(request.actor);
    const fileName = text(rawName, 'fileName', 200);
    if (!/\.xlsx$/i.test(fileName) || /[\\/\x00-\x1f]/.test(fileName)) invalid('fileName', 'Expected an .xlsx file name.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request as UploadRequest) {
      bytes += chunk.length;
      if (bytes > 10 * 1024 * 1024) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'Maximum 10 MiB.');
      chunks.push(Buffer.from(chunk));
    }
    const workbook = await parseWorkbook(Buffer.concat(chunks));
    return this.db.transaction(async (client) => {
      const { rows: [row] } = await client.query('INSERT INTO lcit.import_batches (created_by,file_name,workbook) VALUES ($1,$2,$3) RETURNING id',
        [request.actor.id, fileName, JSON.stringify(workbook)]);
      return { id: row.id, fileName, status: 'uploaded', previewVersion: 0, sheets: this.sheets(workbook) };
    });
  }

  private sheets(workbook: SheetData[]) {
    return workbook.map((sheet) => ({ name: sheet.name, rowCount: sheet.rows.length,
      sampleRows: sheet.rows.slice(0, 5) }));
  }

  async get(request: SessionRequest, rawId: unknown) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    return this.db.transaction(async (client) => {
      const batch = await batchOf(client, id, request.actor, true);
      const { rows } = await client.query('SELECT preview, decision, result FROM lcit.import_rows WHERE batch_id=$1 ORDER BY row_number', [id]);
      return { id, fileName: batch.file_name, status: batch.status, previewVersion: batch.preview_version,
        sheets: this.sheets(batch.workbook), mapping: batch.mapping, rows: rows.map((row) => ({ ...row.preview, decision: row.decision, result: row.result })), result: batch.result };
    });
  }

  async preview(request: SessionRequest, rawId: unknown, input: unknown) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    return this.db.transaction(async (client) => {
      // A single MVCC snapshot makes all matching/reference queries agree.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const batch = await batchOf(client, id, request.actor, true);
      if (batch.status === 'completed') throw new ApiError(409, 'IMPORT_COMPLETED', 'This batch is already completed.');
      const { body, rows, mapping } = normalizeSheet(batch.workbook, input);
      if (body.previewVersion !== batch.preview_version) stale();
      const planned = planRows(rows, await catalog(client));
      const decisions = body.decisions ?? [];
      if (!Array.isArray(decisions) || decisions.length > planned.length) invalid('decisions', 'Expected decisions by row number.');
      const seen = new Set<number>();
      for (const raw of decisions) {
        const decision = bodyOf(raw, ['rowNumber', 'action']);
        const row = planned.find((item) => item.rowNumber === decision.rowNumber);
        if (!row || seen.has(row.rowNumber)) invalid('rowNumber', 'Unknown or repeated row.');
        seen.add(row.rowNumber);
        const action = choice(decision.action, 'action', ['create', 'merge', 'skip']);
        if (action !== 'skip' && (row.status === 'error' || row.status === 'conflict' || row.status === 'duplicate')) invalid('action', 'Resolve this row in the source workbook or skip it.');
        if (action === 'create' && row.status !== 'new') invalid('action', 'Existing records require an explicit merge.');
        row.decision = action;
      }
      await client.query('DELETE FROM lcit.import_rows WHERE batch_id=$1', [id]);
      if (planned.length) await client.query(`INSERT INTO lcit.import_rows (batch_id,row_number,preview,decision)
        SELECT $1, (r->>'rowNumber')::integer, r, r->>'decision' FROM jsonb_array_elements($2::jsonb) r`, [id, JSON.stringify(planned)]);
      await client.query(`UPDATE lcit.import_batches SET status='previewed',preview_version=preview_version+1,mapping=$2 WHERE id=$1`, [id, JSON.stringify(mapping)]);
      return { id, status: 'previewed', previewVersion: batch.preview_version + 1, mapping, rows: planned };
    });
  }

  async confirm(request: SessionRequest, rawId: unknown, input: unknown) {
    requireAdmin(request.actor);
    const id = uuid(rawId);
    const body = bodyOf(input, ['previewVersion', 'rowNumbers']);
    const expected = version(body.previewVersion);
    if (!Array.isArray(body.rowNumbers) || body.rowNumbers.length > 10000 || body.rowNumbers.some((n) => !Number.isInteger(n)) || new Set(body.rowNumbers).size !== body.rowNumbers.length) invalid('rowNumbers', 'Expected unique selected row numbers.');
    const selected = new Set<number>(body.rowNumbers);
    return this.db.transaction(async (client) => {
      const batch = await batchOf(client, id, request.actor, true);
      // The stored receipt is returned even if a retry carries an old preview or different selection.
      if (batch.status === 'completed') return batch.result;
      if (batch.status !== 'previewed' || batch.preview_version !== expected) stale();
      const { rows: stored } = await client.query<{ row_number: number; preview: PlannedRow; decision: string }>(
        'SELECT row_number,preview,decision FROM lcit.import_rows WHERE batch_id=$1 ORDER BY row_number', [id]);
      if ([...selected].some((n) => !stored.some((r) => r.row_number === n))) invalid('rowNumbers', 'Unknown row.');
      // Block catalog writers, including inserts, until matching and writes commit. Normal readers continue.
      await client.query(`LOCK TABLE lcit.organizations, lcit.data_centers, lcit.applications, lcit.servers,
        lcit.server_addresses, lcit.domains, lcit.app_servers, lcit.app_domains IN SHARE ROW EXCLUSIVE MODE`);
      const { rows } = normalizeSheet(batch.workbook, batch.mapping);
      const current = new Map(planRows(rows, await catalog(client)).map((r) => [r.rowNumber, r]));
      const results: { rowNumber: number; outcome: string; applicationId?: string; serverId?: string; domainId?: string }[] = [];
      for (const row of stored) {
        if (!selected.has(row.row_number)) { results.push({ rowNumber: row.row_number, outcome: 'skipped' }); continue; }
        if (row.decision === 'skip') invalid('rowNumbers', 'Selected rows must have create or merge decisions.');
        if (current.get(row.row_number)?.snapshot !== row.preview.snapshot) throw new ApiError(409, 'IMPORT_CONFLICT', 'Catalog changed after preview. Preview this batch again.');
      }
      for (const row of stored) {
        if (!selected.has(row.row_number)) continue;
        const ids = await this.writeRow(client, row.preview);
        results.push({ rowNumber: row.row_number, outcome: row.decision === 'create' ? 'created' : 'merged', ...ids });
      }
      results.sort((a, b) => a.rowNumber - b.rowNumber);
      const receipt = { id, status: 'completed', previewVersion: expected,
        created: results.filter((r) => r.outcome === 'created').length,
        merged: results.filter((r) => r.outcome === 'merged').length,
        skipped: results.filter((r) => r.outcome === 'skipped').length, rows: results };
      for (const result of results) await client.query('UPDATE lcit.import_rows SET result=$3 WHERE batch_id=$1 AND row_number=$2', [id, result.rowNumber, JSON.stringify(result)]);
      await client.query("UPDATE lcit.import_batches SET status='completed',result=$2 WHERE id=$1", [id, JSON.stringify(receipt)]);
      await recordAudit(client, { actorId: request.actor.id, action: 'imports.confirm', targetType: 'import_batches', targetId: id, requestId: requestId(request) });
      return receipt;
    });
  }

  private async writeRow(client: PoolClient, row: PlannedRow) {
    const d = row.data, t = row.targets;
    const { rows: [app] } = await client.query(`INSERT INTO lcit.applications (code,name,organization_id,service_type) VALUES ($1,$2,$3,$4)
      ON CONFLICT (code) DO UPDATE SET name=excluded.name,organization_id=excluded.organization_id,
        service_type=excluded.service_type,version=lcit.applications.version+1 RETURNING id`, [d.applicationCode, d.applicationName, t.organizationId, d.serviceType]);
    let serverId = t.serverId;
    if (serverId) {
      await client.query('UPDATE lcit.servers SET hostname=$2,data_center_id=$3,version=version+1 WHERE id=$1', [serverId, d.hostname, t.dataCenterId]);
    } else {
      const { rows: [server] } = await client.query(`INSERT INTO lcit.servers (code,hostname,data_center_id) VALUES ($1,$2,$3)
        ON CONFLICT (code) DO UPDATE SET hostname=excluded.hostname,data_center_id=excluded.data_center_id,version=lcit.servers.version+1 RETURNING id`, [d.serverCode, d.hostname, t.dataCenterId]);
      serverId = server.id;
    }
    await client.query(`INSERT INTO lcit.server_addresses (server_id,address,network_scope,kind) VALUES ($1,$2,$3,'private') ON CONFLICT DO NOTHING`, [serverId, d.privateIp, d.networkScope]);
    const { rows: [domain] } = await client.query(`INSERT INTO lcit.domains (name,renewal_date) VALUES ($1,$2)
      ON CONFLICT (name) DO UPDATE SET renewal_date=COALESCE(excluded.renewal_date,lcit.domains.renewal_date),version=lcit.domains.version+1 RETURNING id`, [d.domain, d.renewalDate ?? null]);
    await client.query('INSERT INTO lcit.app_servers (application_id,server_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [app.id, serverId]);
    await client.query('INSERT INTO lcit.app_domains (application_id,domain_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [app.id, domain.id]);
    return { applicationId: app.id as string, serverId, domainId: domain.id as string };
  }
}
