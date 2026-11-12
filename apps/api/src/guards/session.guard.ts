import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SessionRequest, sha256 } from '../models/access';
import { AuthService } from '../models/auth.service';
import { ApiError, requestId } from '../shared/api-contract';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const request = http.getRequest<SessionRequest>();
    http.getResponse().setHeader('X-Request-Id', requestId(request));
    http.getResponse().setHeader('Cache-Control', 'no-store');
    const token = request.headers.authorization?.match(/^Bearer ([a-z0-9_-]{43})$/i)?.[1];
    if (!token) throw new ApiError(401, 'INVALID_SESSION', 'Sign in to continue.');
    request.sessionHash = sha256(token);
    const actor = await this.auth.findSessionActor(request.sessionHash);
    if (!actor) throw new ApiError(401, 'INVALID_SESSION', 'Sign in to continue.');
    request.actor = actor;
    return true;
  }
}
