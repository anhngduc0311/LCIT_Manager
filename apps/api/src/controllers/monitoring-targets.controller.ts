import { Body, Controller, Get, HttpCode, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { MonitoringTargetsService } from '../models/monitoring-targets.service';

@ApiTags('monitoring')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/monitoring/targets')
export class MonitoringTargetsController {
  constructor(private readonly targets: MonitoringTargetsService) {}

  @Get()
  @ApiOperation({ operationId: 'monitoring_targets_list', summary: 'Administrator: approved targets, latest result and outage state.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ description: 'Paginated targets, approval state, consecutiveFailures, health and lastCheck.' })
  list(@Req() request: SessionRequest, @Query('page') page: unknown, @Query('pageSize') size: unknown) { return this.targets.list(request, page, size); }

  @Put(':type/:id')
  @HttpCode(200)
  @ApiOperation({ operationId: 'monitoring_targets_approve', summary: 'Administrator: approve current dns/tls endpoint configuration, enable/disable monitoring and reset its health baseline.' })
  @ApiBody({ schema: { type: 'object', required: ['version','enabled'], properties: {
    version: { type: 'integer', minimum: 0, description: '0 for first approval, otherwise current target version.' }, enabled: { type: 'boolean' },
  } } })
  @ApiOkResponse({ description: 'Target id, incremented version, enabled and approved config. Network policy still applies.' })
  approve(@Req() request: SessionRequest, @Param('type') type: string, @Param('id') id: string, @Body() body: unknown) {
    return this.targets.approve(request, type, id, body);
  }

  @Get(':type/:id/checks')
  @ApiOperation({ operationId: 'monitoring_targets_history', summary: 'Administrator: per-endpoint DNS/TLS check history, newest first.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ description: 'Paginated check results with status, errorCode, times, resolved addresses and observed expiry.' })
  history(@Req() request: SessionRequest, @Param('type') type: string, @Param('id') id: string,
    @Query('page') page: unknown, @Query('pageSize') size: unknown) { return this.targets.history(request, type, id, page, size); }
}
