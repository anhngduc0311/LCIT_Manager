import { Controller, Get, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { contentDisposition } from '../models/attachments.service';
import { appStatuses, maxExportRows, ReportsService, serviceTypes } from '../models/reports.service';
import { pageSchema } from '../shared/api-contract';

const filterQueries = [
  ApiQuery({ name: 'organizationId', required: false, type: String }),
  ApiQuery({ name: 'dataCenterId', required: false, type: String }),
  ApiQuery({ name: 'serviceType', required: false, enum: [...serviceTypes] }),
  ApiQuery({ name: 'status', required: false, enum: [...appStatuses] }),
];
const filters = (target: object, key: string, descriptor: PropertyDescriptor) => {
  for (const decorate of filterQueries) decorate(target, key, descriptor);
};
const filterSchema = { type: 'object', properties: {
  organizationId: { type: 'string', nullable: true }, dataCenterId: { type: 'string', nullable: true },
  serviceType: { type: 'string', nullable: true }, status: { type: 'string', nullable: true },
} };
const counted = (extra: Record<string, object>) => ({ type: 'array', items: { type: 'object', properties: extra } });
const dashboardSchema = { type: 'object', properties: {
  filter: filterSchema,
  totals: { type: 'object', properties: { applications: { type: 'integer' }, servers: { type: 'integer' }, domains: { type: 'integer' } } },
  byServiceType: counted({ serviceType: { type: 'string' }, count: { type: 'integer' } }),
  byOrganization: counted({ id: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer' } }),
  byDataCenter: counted({ id: { type: 'string' }, name: { type: 'string' }, applications: { type: 'integer' }, servers: { type: 'integer' } }),
  renewals: { type: 'object', properties: { overdue: { type: 'integer' }, within30: { type: 'integer' }, within90: { type: 'integer' } } },
  upcomingRenewals: counted({ kind: { type: 'string', enum: ['domain', 'tls'] }, source: { type: 'string', nullable: true, enum: ['manual', 'observed'] },
    domainId: { type: 'string' }, name: { type: 'string' }, dueDate: { type: 'string', format: 'date' }, daysLeft: { type: 'integer' } }),
} };
const inventoryItem = { type: 'object', properties: {
  id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, serviceType: { type: 'string' }, status: { type: 'string' },
  organization: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } }, owner: { type: 'string', nullable: true },
  servers: counted({ id: { type: 'string' }, hostname: { type: 'string' }, dataCenter: { type: 'string' }, addresses: { type: 'array', items: { type: 'string' } } }),
  domains: { type: 'array', items: { type: 'string' } },
} };

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @ApiOperation({ operationId: 'dashboard', summary: 'Totals and renewals within the viewer scope. Applications count once per data center.' })
  @filters
  @ApiOkResponse({ schema: dashboardSchema })
  dashboard(@Req() request: SessionRequest, @Query() query: Record<string, unknown>) {
    return this.reports.dashboard(request, query);
  }

  @Get('reports/inventory')
  @ApiOperation({ operationId: 'reports_inventory' })
  @filters
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: { ...pageSchema(inventoryItem), properties: { ...pageSchema(inventoryItem).properties, filter: filterSchema, canExport: { type: 'boolean' } } } })
  inventory(@Req() request: SessionRequest, @Query() query: Record<string, unknown>) {
    return this.reports.inventory(request, query);
  }

  @Get('reports/inventory.xlsx')
  @ApiOperation({ operationId: 'reports_inventory_xlsx', summary: `Same rows and filter as reports/inventory, up to ${maxExportRows} applications. Needs reports.export.` })
  @filters
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async exportInventory(@Req() request: SessionRequest, @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    const buffer = await this.reports.exportInventory(request, query);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      length: buffer.length, disposition: contentDisposition(`Bao-cao-danh-muc-${stamp}.xlsx`),
    });
  }
}
