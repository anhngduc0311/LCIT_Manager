import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags, SchemaObject } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { AccessLaunchService } from '../models/access-launch.service';
import { pageSchema } from '../shared/api-contract';

const endpointSchema: SchemaObject = { type: 'object', properties: {
  id: { type: 'string', format: 'uuid' }, serverId: { type: 'string', format: 'uuid' },
  protocol: { type: 'string', enum: ['ssh','rdp'] }, host: { type: 'string' }, port: { type: 'integer', minimum: 1, maximum: 65535 }, canLaunch: { type: 'boolean' },
} };
const emptyBody = { required: false, schema: { type: 'object' as const, additionalProperties: false } };

@ApiTags('access')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1')
export class AccessLaunchController {
  constructor(private readonly access: AccessLaunchService) {}

  @Post('access-endpoints/:id/launch')
  @HttpCode(200)
  @ApiOperation({ operationId: 'access_endpoints_launch', summary: 'Authorize the stored SSH/RDP destination and audit the decision; does not open a connection or prove login.' })
  @ApiBody(emptyBody)
  @ApiOkResponse({ schema: { type: 'object', required: ['authorizationId','endpointId','serverId','protocol','host','port','authorizedAt'], properties: {
    authorizationId: { type: 'string', format: 'uuid', description: 'Authorization audit request ID, not a bearer token.' },
    endpointId: { type: 'string', format: 'uuid' }, serverId: endpointSchema.properties!.serverId,
    protocol: endpointSchema.properties!.protocol, host: endpointSchema.properties!.host, port: endpointSchema.properties!.port,
    authorizedAt: { type: 'string', format: 'date-time' },
  } } })
  launch(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) { return this.access.launch(request, id, body); }

  @Get('servers/:id/access-endpoints')
  @ApiOperation({ operationId: 'access_endpoints_available', summary: 'Specialists discover only explicitly granted endpoints on assigned servers; administrators see all endpoints with canLaunch.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: pageSchema(endpointSchema) })
  list(@Req() request: SessionRequest, @Param('id') id: string, @Query('page') page: unknown, @Query('pageSize') size: unknown) { return this.access.listEndpoints(request, id, page, size); }

  @Get('users/:id/access-endpoints')
  @ApiOperation({ operationId: 'access_grants_list', summary: 'Administrator: inspect per-endpoint grants and whether the approved configuration is current.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ description: 'Paginated grants including endpointId, serverId, protocol, host, port, grantedBy, grantedAt and isCurrent.' })
  grants(@Req() request: SessionRequest, @Param('id') id: string, @Query('page') page: unknown, @Query('pageSize') size: unknown) { return this.access.grants(request, id, page, size); }

  @Put('users/:id/access-endpoints/:endpointId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'access_grants_grant', summary: 'Administrator: explicitly grant the current saved endpoint, including for administrators themselves.' })
  @ApiBody(emptyBody)
  @ApiNoContentResponse()
  grant(@Req() request: SessionRequest, @Param('id') id: string, @Param('endpointId') endpoint: string, @Body() body: unknown) { return this.access.changeGrant(request, id, endpoint, true, body); }

  @Delete('users/:id/access-endpoints/:endpointId')
  @HttpCode(204)
  @ApiOperation({ operationId: 'access_grants_revoke', summary: 'Administrator: revoke an endpoint grant. Repeated revocation is safe.' })
  @ApiBody(emptyBody)
  @ApiNoContentResponse()
  revoke(@Req() request: SessionRequest, @Param('id') id: string, @Param('endpointId') endpoint: string, @Body() body: unknown) { return this.access.changeGrant(request, id, endpoint, false, body); }
}
