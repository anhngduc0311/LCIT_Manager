import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { importFields } from '../models/excel-import';
import { ImportsService } from '../models/imports.service';

@ApiTags('imports')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1/imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @ApiOperation({ operationId: 'imports_upload', summary: 'Administrator: upload raw .xlsx, return sheets and sample rows. Batches are private to their creator.' })
  @ApiConsumes('application/octet-stream')
  @ApiQuery({ name: 'fileName', required: true, type: String })
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiCreatedResponse({ description: 'Batch id, status, previewVersion and sheets (name, rowCount, sampleRows).' })
  upload(@Req() request: SessionRequest, @Query('fileName') fileName: unknown) {
    return this.imports.upload(request, fileName);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'imports_get', summary: 'Read sheets, persisted preview, decisions and final receipt.' })
  @ApiOkResponse({ description: 'Batch including rows with original rowNumber, data, errors, status, reasons, matches, decision and result.' })
  get(@Req() request: SessionRequest, @Param('id') id: string) {
    return this.imports.get(request, id);
  }

  @Post(':id/preview')
  @HttpCode(200)
  @ApiOperation({ operationId: 'imports_preview', summary: 'Map columns, normalize and match catalog; save row decisions without catalog writes.' })
  @ApiBody({ schema: { type: 'object', required: ['sheet', 'columns', 'previewVersion'], properties: {
    sheet: { type: 'string' }, headerRow: { type: 'integer', default: 1, minimum: 1 },
    previewVersion: { type: 'integer', minimum: 0 },
    columns: { type: 'object', description: '1-based column numbers. First nine fields are required.',
      properties: Object.fromEntries(importFields.map((field) => [field, { type: 'integer', minimum: 1, maximum: 64 }])) },
    decisions: { type: 'array', items: { type: 'object', required: ['rowNumber', 'action'], properties: {
      rowNumber: { type: 'integer' }, action: { type: 'string', enum: ['create', 'merge', 'skip'] },
    } } },
  } } })
  @ApiOkResponse({ description: 'New previewVersion and rows. Status: new, match, duplicate, conflict or error. Explicit merge is required for existing records.' })
  preview(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.imports.preview(request, id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @ApiOperation({ operationId: 'imports_confirm', summary: 'Atomically apply selected rows and audit; completed retries return the stored receipt.' })
  @ApiBody({ schema: { type: 'object', required: ['previewVersion', 'rowNumbers'], properties: {
    previewVersion: { type: 'integer', minimum: 1 }, rowNumbers: { type: 'array', uniqueItems: true, items: { type: 'integer' } },
  } } })
  @ApiOkResponse({ description: 'Stored receipt with created, merged, skipped counts and per-row IDs. Catalog conflicts return 409 and require a new preview.' })
  confirm(@Req() request: SessionRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.imports.confirm(request, id, body);
  }
}
