import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags, SchemaObject } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { Child, children, Collection, Fields, InfrastructureService, Link, links, roots } from '../models/infrastructure.service';
import { pageSchema } from '../shared/api-contract';

const versionBody = { schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer', minimum: 1 } } } };
const uuidSchema = { type: 'string', format: 'uuid' };
const idsSchema = { type: 'array', items: uuidSchema };
const childResultSchema: SchemaObject = { type: 'object', required: ['id', 'version'], properties: { id: uuidSchema, ...versionBody.schema.properties } };
function resourceBody(fields: Fields, create: boolean, versioned: boolean) {
  return { schema: { type: 'object', required: [
    ...(versioned ? ['version'] : []), ...(create ? Object.keys(fields).filter((key) => fields[key].required) : []),
  ], properties: {
    ...(versioned ? versionBody.schema.properties : {}),
    ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, {
      type: key === 'port' ? 'integer' : 'string', ...(!field.required && { nullable: true }),
    }])),
  } } };
}

function readSchema(fields: Fields, extra: Record<string, SchemaObject> = {}): SchemaObject {
  return { type: 'object', properties: { id: uuidSchema, ...resourceBody(fields, false, false).schema.properties, ...extra } };
}

function resourceController(kind: Collection) {
  const item = readSchema(roots[kind], { ...versionBody.schema.properties, archivedAt: { type: 'string', format: 'date-time', nullable: true } });
  const relationFields: Record<string, SchemaObject> = kind === 'servers' ? {
    domainIds: idsSchema,
    addresses: { type: 'array', items: readSchema(children.addresses.fields) },
    accessEndpoints: { type: 'array', items: readSchema(children['access-endpoints'].fields) },
  } : {
    serverIds: idsSchema,
    dnsRecords: { type: 'array', items: readSchema(children['dns-records'].fields) },
    tlsEndpoints: { type: 'array', items: readSchema(children['tls-endpoints'].fields, {
      observedExpiryAt: { type: 'string', format: 'date-time', nullable: true },
    }) },
  };
  const detail = { ...item, properties: { ...item.properties, applicationIds: idsSchema, ...relationFields } };
  @ApiTags(kind)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @Controller(`api/v1/${kind}`)
  class ResourceController {
    constructor(private readonly infrastructure: InfrastructureService) {}

    @Get()
    @ApiOperation({ operationId: `${kind}_list` })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    @ApiOkResponse({ schema: pageSchema(item) })
    list(@Req() request: SessionRequest, @Query('page') page: unknown, @Query('pageSize') size: unknown) {
      return this.infrastructure.list(kind, request, page, size);
    }

    @Get(':id')
    @ApiOperation({ operationId: `${kind}_detail` })
    @ApiOkResponse({ schema: detail })
    detail(@Req() request: SessionRequest, @Param('id') id: string) {
      return this.infrastructure.detail(kind, request, id);
    }

    @Post()
    @ApiOperation({ operationId: `${kind}_create` })
    @ApiBody(resourceBody(roots[kind], true, false))
    @ApiCreatedResponse({ schema: item })
    create(@Req() request: SessionRequest, @Body() body: unknown) {
      return this.infrastructure.save(kind, request, body);
    }

    @Patch(':id')
    @ApiOperation({ operationId: `${kind}_update` })
    @ApiBody(resourceBody(roots[kind], false, true))
    @ApiOkResponse({ schema: item })
    update(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
      return this.infrastructure.save(kind, request, body, id);
    }

    @Post(':id/archive')
    @HttpCode(200)
    @ApiOperation({ operationId: `${kind}_archive` })
    @ApiBody(versionBody)
    @ApiOkResponse({ schema: item })
    archive(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
      return this.infrastructure.archive(kind, request, id, body);
    }
  }
  return ResourceController;
}

function childController(kind: Child) {
  const { root, fields } = children[kind];
  @ApiTags(root)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @Controller(`api/v1/${root}/:id/${kind}`)
  class ChildController {
    constructor(private readonly infrastructure: InfrastructureService) {}

    @Post()
    @ApiOperation({ operationId: `${kind}_create` })
    @ApiBody(resourceBody(fields, true, true))
    @ApiCreatedResponse({ schema: childResultSchema })
    create(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
      return this.infrastructure.child(kind, request, id, body);
    }

    @Patch(':childId')
    @ApiOperation({ operationId: `${kind}_update` })
    @ApiBody(resourceBody(fields, false, true))
    @ApiOkResponse({ schema: childResultSchema })
    update(@Req() request: SessionRequest, @Param('id') id: string, @Param('childId') childId: string, @Body() body: unknown) {
      return this.infrastructure.child(kind, request, id, body, childId);
    }

    @Delete(':childId')
    @ApiOperation({ operationId: `${kind}_delete` })
    @ApiBody(versionBody)
    @ApiOkResponse({ schema: childResultSchema })
    remove(@Req() request: SessionRequest, @Param('id') id: string, @Param('childId') childId: string, @Body() body: unknown) {
      return this.infrastructure.child(kind, request, id, body, childId, true);
    }
  }
  return ChildController;
}

function linkController(kind: Link) {
  @ApiTags(links[kind].root)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @Controller(`api/v1/${links[kind].path}`)
  class LinkController {
    constructor(private readonly infrastructure: InfrastructureService) {}

    @Put(':targetId')
    @ApiOperation({ operationId: `${kind}_link` })
    @ApiBody(versionBody)
    @ApiOkResponse(versionBody)
    link(@Req() request: SessionRequest, @Param('id') id: string, @Param('targetId') targetId: string, @Body() body: unknown) {
      return this.infrastructure.link(kind, request, id, targetId, body, true);
    }

    @Delete(':targetId')
    @ApiOperation({ operationId: `${kind}_unlink` })
    @ApiBody(versionBody)
    @ApiOkResponse(versionBody)
    unlink(@Req() request: SessionRequest, @Param('id') id: string, @Param('targetId') targetId: string, @Body() body: unknown) {
      return this.infrastructure.link(kind, request, id, targetId, body, false);
    }
  }
  return LinkController;
}

export const infrastructureControllers = [
  ...(['servers', 'domains'] as const).map(resourceController),
  ...(Object.keys(children) as Child[]).map(childController),
  ...(Object.keys(links) as Link[]).map(linkController),
];
