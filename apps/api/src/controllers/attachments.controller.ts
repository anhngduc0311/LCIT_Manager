import { Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiProduces,
  ApiQuery, ApiTags,
} from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { AttachmentsService } from '../models/attachments.service';
import { attachmentTypes } from '../models/file-store';
import { permissions, PermissionsService } from '../models/permissions.service';
import { pageSchema } from '../shared/api-contract';

const attachmentSchema = { type: 'object', required: ['id', 'applicationId', 'fileName', 'mediaType', 'sizeBytes', 'sha256', 'uploadedBy', 'uploadedByName', 'uploadedAt'], properties: {
  id: { type: 'string', format: 'uuid' }, applicationId: { type: 'string', format: 'uuid' },
  fileName: { type: 'string' }, mediaType: { type: 'string' }, sizeBytes: { type: 'integer' }, sha256: { type: 'string' },
  uploadedBy: { type: 'string', format: 'uuid' }, uploadedByName: { type: 'string', nullable: true },
  uploadedAt: { type: 'string', format: 'date-time' },
} };
const listSchema = (() => {
  const base = pageSchema(attachmentSchema);
  return { ...base, required: [...(base.required ?? []), 'canUpload', 'canDownload'], properties: {
    ...base.properties, canUpload: { type: 'boolean' }, canDownload: { type: 'boolean' },
  } };
})();

@ApiTags('attachments')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  @ApiOperation({ operationId: 'attachments_list', summary: 'Available attachments of an application in scope.' })
  @ApiQuery({ name: 'applicationId', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ schema: listSchema })
  list(@Req() request: SessionRequest, @Query('applicationId') applicationId: unknown,
    @Query('page') page: unknown, @Query('pageSize') size: unknown) {
    return this.attachments.list(request, applicationId, page, size);
  }

  @Post()
  @ApiOperation({ operationId: 'attachments_upload', summary: `Upload the raw file body. Types: ${Object.keys(attachmentTypes).join(', ')}.` })
  @ApiConsumes('application/octet-stream')
  @ApiQuery({ name: 'applicationId', required: true, type: String })
  @ApiQuery({ name: 'fileName', required: true, type: String })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiCreatedResponse({ schema: attachmentSchema })
  upload(@Req() request: SessionRequest, @Query('applicationId') applicationId: unknown, @Query('fileName') fileName: unknown) {
    return this.attachments.upload(request, applicationId, fileName);
  }

  @Get(':id/download')
  @ApiOperation({ operationId: 'attachments_download' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async download(@Req() request: SessionRequest, @Param('id') id: string,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    const file = await this.attachments.download(request, id);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return file;
  }

  @Post(':id/archive')
  @HttpCode(204)
  @ApiOperation({ operationId: 'attachments_archive' })
  @ApiNoContentResponse()
  archive(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.attachments.archive(request, id);
  }
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/users/:id/permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  @ApiOkResponse({ schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: {
    type: 'object', required: ['permission', 'grantedAt'], properties: {
      permission: { type: 'string', enum: [...permissions] }, grantedAt: { type: 'string', format: 'date-time' },
    },
  } } } } })
  list(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.permissionsService.list(request, id);
  }

  @Put(':permission')
  @HttpCode(204)
  @ApiParam({ name: 'permission', enum: [...permissions] })
  @ApiNoContentResponse()
  grant(@Req() request: SessionRequest, @Param('id') id: string, @Param('permission') permission: string) {
    return this.permissionsService.change(request, id, permission, true);
  }

  @Delete(':permission')
  @HttpCode(204)
  @ApiParam({ name: 'permission', enum: [...permissions] })
  @ApiNoContentResponse()
  revoke(@Req() request: SessionRequest, @Param('id') id: string, @Param('permission') permission: string) {
    return this.permissionsService.change(request, id, permission, false);
  }
}
