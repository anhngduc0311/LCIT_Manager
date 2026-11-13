import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { MonitoringService } from '../models/monitoring.service';

@ApiTags('monitoring')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/monitoring/jobs')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get()
  @ApiOperation({ operationId: 'monitoring_jobs_list', summary: 'Administrator: configured schedules, handler readiness and persisted latest executions.' })
  @ApiOkResponse({ schema: { type: 'object', required: ['enabled', 'timeZone', 'items'], properties: {
    enabled: { type: 'boolean' }, timeZone: { type: 'string' }, items: { type: 'array', items: {
      type: 'object', required: ['key', 'cron', 'handlerRegistered', 'state', 'nextRunAt', 'lastSuccessAt', 'lastRun'], properties: {
        key: { type: 'string', enum: ['expiry', 'dns_tls'] }, cron: { type: 'string' }, handlerRegistered: { type: 'boolean' },
        state: { type: 'string', enum: ['disabled', 'waiting_handler', 'scheduled'] },
        nextRunAt: { type: 'string', format: 'date-time', nullable: true },
        lastSuccessAt: { type: 'string', format: 'date-time', nullable: true },
        lastRun: { type: 'object', nullable: true, properties: {
          id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'interrupted'] },
          startedAt: { type: 'string', format: 'date-time' }, finishedAt: { type: 'string', format: 'date-time', nullable: true },
          errorCode: { type: 'string', nullable: true },
        } },
      },
    } },
  } } })
  list(@Req() request: SessionRequest) { return this.monitoring.list(request); }
}
