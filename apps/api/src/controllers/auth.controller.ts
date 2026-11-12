import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SessionGuard } from '../guards/session.guard';
import { actorSchema, SessionRequest } from '../models/access';
import { AuthService } from '../models/auth.service';
import { ApiRequest, requestId } from '../shared/api-contract';

@ApiTags('auth')
@Controller('api/v1')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  @ApiBody({ schema: { type: 'object', required: ['username', 'password'], properties: {
    username: { type: 'string' }, password: { type: 'string', format: 'password' },
  } } })
  @ApiOkResponse({ schema: { type: 'object', required: ['token', 'expiresAt', 'user'], properties: {
    token: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, user: actorSchema,
  } } })
  login(@Body() body: unknown, @Req() request: ApiRequest, @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void }) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Request-Id', requestId(request));
    return this.auth.login(body, request);
  }

  @Post('auth/logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  async logout(@Req() request: SessionRequest) {
    await this.auth.logout(request);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ schema: actorSchema })
  me(@Req() request: SessionRequest) {
    return request.actor;
  }
}
