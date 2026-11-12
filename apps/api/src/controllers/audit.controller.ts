import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { AuditService } from '../models/audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  list(@Req() request: SessionRequest, @Query('page') rawPage: unknown, @Query('pageSize') rawSize: unknown) {
    return this.audit.list(request, rawPage, rawSize);
  }
}
