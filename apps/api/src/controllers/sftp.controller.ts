import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { IncomingMessage } from 'node:http';
import { SessionGuard } from '../guards/session.guard';
import { SessionRequest } from '../models/access';
import { contentDisposition } from '../models/attachments.service';
import { SftpService, SFTP_MAX_BYTES } from '../models/sftp.service';
import { ApiError } from '../shared/api-contract';

@ApiTags('sftp')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('api/v1')
export class SftpController {
  constructor(private readonly sftp: SftpService) {}

  @Post('access-endpoints/:id/sftp/sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Open SFTP for the granted SSH endpoint; without fingerprint, return a host-key challenge before authentication.' })
  @ApiBody({ schema: { type: 'object', required: ['username', 'password'], additionalProperties: false, properties: {
    username: { type: 'string' }, password: { type: 'string', format: 'password' }, fingerprint: { type: 'string' },
  } } })
  open(@Req() request: SessionRequest, @Param('id') id: string, @Body() input: unknown) { return this.sftp.open(request, id, input); }

  @Post('access-endpoints/:id/ssh/sessions')
  @HttpCode(200)
  openSsh(@Req() request: SessionRequest, @Param('id') id: string, @Body() input: unknown) { return this.sftp.open(request, id, input, true); }

  @Post('sftp/sessions/:id/files/open')
  @HttpCode(200)
  openFiles(@Req() request: SessionRequest, @Param('id') id: string) { return this.sftp.openFiles(request, id); }

  @Get('sftp/sessions/:id/files')
  @ApiOperation({ summary: 'List a remote directory. Rechecks the current endpoint grant.' })
  list(@Req() request: SessionRequest, @Param('id') id: string, @Query('path') path: unknown) { return this.sftp.list(request, id, path); }

  @Delete('sftp/sessions/:id/files')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a regular remote file using the active SFTP session.' })
  removeFile(@Req() request: SessionRequest, @Param('id') id: string, @Query('path') path: unknown) { return this.sftp.removeFile(request, id, path); }

  @Post('sftp/sessions/:id/shell')
  @HttpCode(204)
  openShell(@Req() request: SessionRequest, @Param('id') id: string, @Body() input: unknown) { return this.sftp.openShell(request, id, input); }

  @Get('sftp/sessions/:id/shell')
  readShell(@Req() request: SessionRequest, @Param('id') id: string) { return this.sftp.readShell(request, id); }

  @Post('sftp/sessions/:id/shell/input')
  @HttpCode(204)
  writeShell(@Req() request: SessionRequest, @Param('id') id: string, @Body() input: unknown) { return this.sftp.writeShell(request, id, input); }

  @Post('sftp/sessions/:id/upload')
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Upload a new remote file, maximum 20 MiB. Existing files are never overwritten.' })
  async upload(@Req() request: SessionRequest & IncomingMessage, @Param('id') id: string, @Query('path') path: unknown) {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/octet-stream') throw new ApiError(415, 'SFTP_BINARY_REQUIRED', 'Send an octet-stream body.');
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => request.destroy(), 30_000);
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > SFTP_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Maximum 20 MiB.');
        chunks.push(bytes);
      }
    } finally { clearTimeout(timer); }
    return this.sftp.upload(request, id, path, Buffer.concat(chunks));
  }

  @Get('sftp/sessions/:id/download')
  @ApiOperation({ summary: 'Download a regular remote file, maximum 20 MiB.' })
  async download(@Req() request: SessionRequest, @Param('id') id: string, @Query('path') path: unknown) {
    const file = await this.sftp.download(request, id, path);
    return new StreamableFile(file.bytes, { type: 'application/octet-stream', disposition: contentDisposition(file.name), length: file.bytes.length });
  }

  @Delete('sftp/sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Close an SFTP session owned by this login session.' })
  close(@Req() request: SessionRequest, @Param('id') id: string) { return this.sftp.close(request, id); }
}
