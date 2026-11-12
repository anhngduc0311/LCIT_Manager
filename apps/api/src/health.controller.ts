import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Database } from './database';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: Database) {}

  @Get('live')
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ schema: { example: { status: 'ok', database: 'up' } } })
  @ApiServiceUnavailableResponse({
    schema: { example: { status: 'unavailable', database: 'down' } },
  })
  async ready() {
    try {
      await this.database.ping();
      return { status: 'ok', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'down' });
    }
  }
}
