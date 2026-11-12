import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { CatalogService, collections, Kind } from '../models/catalog.service';
import { pageSchema } from '../shared/api-contract';

const versionBody = { schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer', minimum: 1 } } } };

function catalogController(kind: Kind) {
  const properties = Object.fromEntries(Object.entries(collections[kind].fields).map(([key, field]) => [key, field.schema]));
  const item = { type: 'object', required: ['id', 'version', 'archivedAt', ...Object.keys(properties)], properties: {
    ...properties, id: { type: 'string', format: 'uuid' }, version: { type: 'integer' },
    archivedAt: { type: 'string', format: 'date-time', nullable: true },
  } };
  const relations = ['databaseIds', 'serverIds', 'domainIds', 'directDomainIds', 'dnsRecordIds'];
  const withOwner = kind === 'applications' || kind === 'databases' ? { ...item, required: [...item.required, 'ownerDisplayName'], properties: {
    ...item.properties, ownerDisplayName: { type: 'string', nullable: true },
  } } : item;
  const detail = kind === 'applications' ? { ...withOwner, required: [...withOwner.required, ...relations], properties: {
    ...withOwner.properties, ...Object.fromEntries(relations.map((key) => [key, { type: 'array', items: { type: 'string', format: 'uuid' } }])),
  } } : withOwner;
  @ApiTags(kind)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @Controller(`api/v1/${kind}`)
  class CollectionController {
    constructor(private readonly catalog: CatalogService) {}

    @Get()
    @ApiOperation({ operationId: `${kind}_list` })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'pageSize', required: false, type: Number })
    @ApiOkResponse({ schema: pageSchema(item) })
    list(@Req() request: SessionRequest, @Query('page') page: unknown, @Query('pageSize') size: unknown) {
      return this.catalog.list(kind, request, page, size);
    }

    @Get(':id')
    @ApiOperation({ operationId: `${kind}_detail` })
    @ApiOkResponse({ schema: detail })
    detail(@Req() request: SessionRequest, @Param('id') id: string) {
      return this.catalog.detail(kind, request, id);
    }

    @Post()
    @ApiOperation({ operationId: `${kind}_create` })
    @ApiBody({ schema: { type: 'object', properties, required: collections[kind].required } })
    @ApiCreatedResponse({ schema: item })
    create(@Req() request: SessionRequest, @Body() body: unknown) {
      return this.catalog.create(kind, request, body);
    }

    @Patch(':id')
    @ApiOperation({ operationId: `${kind}_update` })
    @ApiBody({ schema: { type: 'object', properties: { ...properties, ...versionBody.schema.properties }, required: ['version'] } })
    @ApiOkResponse({ schema: item })
    update(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
      return this.catalog.update(kind, request, id, body);
    }

    @Post(':id/archive')
    @HttpCode(200)
    @ApiOperation({ operationId: `${kind}_archive` })
    @ApiBody(versionBody)
    @ApiOkResponse({ schema: item })
    archive(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
      return this.catalog.archive(kind, request, id, body);
    }
  }
  Object.defineProperty(CollectionController, 'name', { value: `${collections[kind].table}Controller` });
  return CollectionController;
}

export const catalogControllers = (Object.keys(collections) as Kind[]).map(catalogController);

@ApiTags('applications')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/applications/:id/databases')
export class ApplicationDatabasesController {
  constructor(private readonly catalog: CatalogService) {}

  @Put(':databaseId')
  @ApiBody(versionBody)
  @ApiOkResponse(versionBody)
  link(@Req() request: SessionRequest, @Param('id') id: string, @Param('databaseId') databaseId: string, @Body() body: unknown) {
    return this.catalog.linkDatabase(request, id, databaseId, body, true);
  }

  @Delete(':databaseId')
  @ApiBody(versionBody)
  @ApiOkResponse(versionBody)
  unlink(@Req() request: SessionRequest, @Param('id') id: string, @Param('databaseId') databaseId: string, @Body() body: unknown) {
    return this.catalog.linkDatabase(request, id, databaseId, body, false);
  }
}
