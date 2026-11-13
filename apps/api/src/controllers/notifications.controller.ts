import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags, SchemaObject } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { NotificationsService } from '../models/notifications.service';
import { pageSchema } from '../shared/api-contract';

const nullableDate: SchemaObject = { type: 'string', format: 'date-time', nullable: true };
const alertSchema: SchemaObject = { type: 'object', required: ['id','createdAt','kind','source','resourceType','resourceId',
  'domainId','domainName','resourceLabel','expiryDate','thresholdDays','check'], properties: {
  id: { type: 'string', format: 'uuid' }, createdAt: { type: 'string', format: 'date-time' },
  kind: { type: 'string', enum: ['expiry','outage','recovery'] },
  source: { type: 'string', enum: ['manual_domain','manual_tls','observed_tls','dns','tls'] },
  resourceType: { type: 'string', enum: ['domain','dns_record','tls_endpoint'] }, resourceId: { type: 'string', format: 'uuid' },
  domainId: { type: 'string', format: 'uuid' }, domainName: { type: 'string' }, resourceLabel: { type: 'string' },
  expiryDate: { type: 'string', format: 'date', nullable: true }, thresholdDays: { type: 'integer', nullable: true, enum: [0,7,14,30,90] },
  check: { type: 'object', nullable: true, properties: {
    status: { type: 'string' }, errorCode: { type: 'string', nullable: true }, finishedAt: { type: 'string', format: 'date-time' },
  } },
} };
const readSchema: SchemaObject = { type: 'object', required: ['id','createdAt','readAt'], properties: {
  id: { type: 'string', format: 'uuid' }, createdAt: { type: 'string', format: 'date-time' }, readAt: nullableDate,
} };
const notificationSchema: SchemaObject = { ...readSchema, required: [...readSchema.required!, 'alert'], properties: { ...readSchema.properties, alert: alertSchema } };
const notificationsPage = pageSchema(notificationSchema);
notificationsPage.required = [...notificationsPage.required!, 'unreadCount'];
notificationsPage.properties = { ...notificationsPage.properties, unreadCount: { type: 'integer', description: 'Unread visible owned notifications matching kind/source/domain filters, regardless of read filter.' } };

function filtersDocumentation() {
  return (target: object, key: string, descriptor: PropertyDescriptor) => {
    for (const [name, type, values] of [
      ['page', Number], ['pageSize', Number], ['domainId', String],
      ['kind', String, ['expiry','outage','recovery']], ['source', String, ['manual_domain','manual_tls','observed_tls','dns','tls']],
    ] as const) ApiQuery({ name, required: false, type, ...(values ? { enum: [...values] } : {}) })(target, key, descriptor);
  };
}

@ApiTags('alerts')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/alerts')
export class AlertsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get()
  @ApiOperation({ operationId: 'alerts_list', summary: 'Alert history in current resource scope, independently of notification delivery.' })
  @filtersDocumentation()
  @ApiOkResponse({ schema: pageSchema(alertSchema) })
  list(@Req() request: SessionRequest, @Query() query: Record<string, unknown>) { return this.notifications.alerts(request, query); }

  @Get(':id')
  @ApiOperation({ operationId: 'alerts_detail', summary: 'Read an alert only while its resource remains visible.' })
  @ApiOkResponse({ schema: alertSchema })
  detail(@Req() request: SessionRequest, @Param('id') id: string) { return this.notifications.alert(request, id); }
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get()
  @ApiOperation({ operationId: 'notifications_list', summary: 'Own persisted notifications filtered by current resource permissions; stable IDs support desktop deduplication.' })
  @filtersDocumentation()
  @ApiQuery({ name: 'read', required: false, enum: ['all','unread','read'] })
  @ApiOkResponse({ schema: notificationsPage })
  list(@Req() request: SessionRequest, @Query() query: Record<string, unknown>) { return this.notifications.list(request, query); }

  @Get(':id')
  @ApiOperation({ operationId: 'notifications_detail', summary: 'Read an owned notification only while its resource remains visible.' })
  @ApiOkResponse({ schema: notificationSchema })
  detail(@Req() request: SessionRequest, @Param('id') id: string) { return this.notifications.detail(request, id); }

  @Patch(':id')
  @ApiOperation({ operationId: 'notifications_mark_read', summary: 'Set own read state. Repeated read=true preserves the first read timestamp. Hidden or foreign IDs return 404.' })
  @ApiBody({ schema: { type: 'object', required: ['read'], properties: { read: { type: 'boolean' } } } })
  @ApiOkResponse({ schema: readSchema })
  markRead(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) { return this.notifications.markRead(request, id, body); }
}
