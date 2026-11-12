import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { SearchService } from '../models/search.service';
import { pageSchema } from '../shared/api-contract';

@ApiTags('search')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: pageSchema({ type: 'object', required: ['id', 'name', 'code', 'organization', 'owner', 'servers', 'domains'], properties: {
    id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, code: { type: 'string' },
    organization: { type: 'object' }, owner: { type: 'object', nullable: true },
    servers: { type: 'array', items: { type: 'object' } }, domains: { type: 'array', items: { type: 'object' } },
  } }) })
  search(@Req() request: SessionRequest, @Query('q') query: unknown, @Query('page') page: unknown, @Query('pageSize') size: unknown) {
    return this.searchService.search(request, query, page, size);
  }
}
