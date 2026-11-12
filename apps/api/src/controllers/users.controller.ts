import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { accountStatuses, actorSchema, roles, SessionRequest } from '../models/access';
import { assignmentTypes, UsersService } from '../models/users.service';
import { pageSchema } from '../shared/api-contract';

const properties = {
  username: { type: 'string' }, displayName: { type: 'string' },
  password: { type: 'string', format: 'password', minLength: 12, maxLength: 256 },
  role: { type: 'string', enum: [...roles] }, status: { type: 'string', enum: [...accountStatuses] },
};
const userSchema = { ...actorSchema, required: [...actorSchema.required, 'status', 'version'], properties: {
  ...actorSchema.properties, status: properties.status, version: { type: 'integer' },
} };

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: pageSchema(userSchema) })
  list(@Req() request: SessionRequest, @Query('page') page: unknown, @Query('pageSize') size: unknown) {
    return this.users.list(request, page, size);
  }

  @Get(':id')
  @ApiOkResponse({ schema: userSchema })
  get(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.users.get(request, id);
  }

  @Post()
  @ApiBody({ schema: { type: 'object', properties, required: ['username', 'displayName', 'password', 'role'] } })
  @ApiCreatedResponse({ schema: userSchema })
  create(@Req() request: SessionRequest, @Body() body: unknown) {
    return this.users.create(request, body);
  }

  @Patch(':id')
  @ApiBody({ schema: { type: 'object', properties: { ...properties, version: { type: 'integer' } }, required: ['version'] } })
  @ApiOkResponse({ schema: userSchema })
  update(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.update(request, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiBody({ schema: { type: 'object', properties: { version: { type: 'integer' } }, required: ['version'] } })
  @ApiNoContentResponse()
  remove(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.users.remove(request, id, body);
  }

  @Get(':id/assignments')
  @ApiOkResponse({ schema: { type: 'object', required: ['organizationIds', 'applicationIds'], properties: {
    organizationIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
    applicationIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
  } } })
  assignments(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.users.assignments(request, id);
  }

  @Put(':id/assignments/:type/:targetId')
  @HttpCode(204)
  @ApiParam({ name: 'type', enum: Object.keys(assignmentTypes) })
  grant(@Req() request: SessionRequest, @Param('id') id: string, @Param('type') type: string, @Param('targetId') target: string) {
    return this.users.assign(request, id, type, target, true);
  }

  @Delete(':id/assignments/:type/:targetId')
  @HttpCode(204)
  @ApiParam({ name: 'type', enum: Object.keys(assignmentTypes) })
  revoke(@Req() request: SessionRequest, @Param('id') id: string, @Param('type') type: string, @Param('targetId') target: string) {
    return this.users.assign(request, id, type, target, false);
  }
}
